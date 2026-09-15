/**
 * The P1 pipeline: find real one-ticket overnight candidates.
 *
 * Order matters, and it is the whole reason a metered free tier is viable:
 *
 *   1. Route graph (OFFLINE, zero API calls) narrows ~40 possible gateways to a
 *      handful, using carriers, detour ratio and ticketability.
 *   2. Only then does the schedule source get called — once for the origin's
 *      board, then once per surviving gateway.
 *   3. Pair, measure in UTC, classify, score, and attach programmes and entry rules.
 *
 * Reversing 1 and 2 would spend the month's quota on a single search.
 *
 * The source is injected, so tests run against a fake and no network.
 */

import { classifyLayover, usableCityHours } from './layover.mjs';
import { localDate } from './time.mjs';

/**
 * A whole day's departures, across however many windows the vendor's per-request
 * cap requires. Windows are half-open — [0,12) then [12,24) — but a vendor may
 * still return a boundary flight twice, so results are deduped on flight number
 * plus departure instant rather than trusted to be disjoint.
 */
async function fetchDay(source, airport, date, windows) {
  const seen = new Set();
  const out = [];
  for (const [fromHour, toHour] of windows) {
    const flights = await source.getDepartures(airport, date, { fromHour, toHour });
    for (const f of flights) {
      const key = `${f.flightNumber}@${f.departureUtc?.getTime() ?? '?'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
  }
  return out;
}

const DEFAULT = {
  maxGateways: 4,
  minLayoverHours: 8,
  maxLayoverHours: 36,
  // FULL DAY by default. AeroDataBox caps a request at 12 hours, so a whole day
  // costs two calls per airport — and that is the right default, because the
  // previous single 06:00–18:00 window made every evening departure invisible.
  // Seattle's long-haul flights to Asia largely leave in the afternoon and
  // evening, so the tool was structurally unable to see the routings it exists
  // to find. Narrow it with `windows` when quota matters more than coverage.
  windows: [[0, 12], [12, 24]],
  onlySameCarrier: false,
  passport: 'US',
};

/** 'YYYY-MM-DD' plus n days, without touching local time. */
export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * @param {object} deps
 * @param {{getDepartures:Function}} deps.source
 * @param {object} deps.network        from createNetwork()
 * @param {object} [deps.entryRules]   from createEntryRules()
 */
export function createSearch({ source, network, entryRules = null, baggageRules = null }) {
  /**
   * @param {string} origin
   * @param {string} destination
   * @param {string} date           departure date, 'YYYY-MM-DD'
   * @param {object} [options]
   */
  async function findOvernightCandidates(origin, destination, date, options = {}) {
    const opt = { ...DEFAULT, ...options };

    // ── 1. Offline shortlist ────────────────────────────────────────────────
    const gateways = network.findGateways(origin, destination, {
      onlySameCarrier: opt.onlySameCarrier,
      limit: opt.maxGateways,
    });
    if (!gateways.length) {
      return { candidates: [], gateways: [], reason: 'no-gateways', apiCalls: 0 };
    }

    const wanted = new Set(gateways.map((g) => g.via));

    // ── 2. Schedules, shortlist only ────────────────────────────────────────
    const perDay = opt.windows.length;
    const outbound = (await fetchDay(source, origin, date, opt.windows))
      .filter((f) => wanted.has(f.destination) && f.arrivalUtc);

    if (!outbound.length) {
      return { candidates: [], gateways, reason: 'no-outbound-flights', apiCalls: perDay };
    }

    // Which gateway boards to fetch, derived from each leg's LOCAL ARRIVAL DATE
    // at the gateway — not from the origin's departure date.
    //
    // Crossing the date line breaks the naive version: SEA→NRT leaves on the
    // 13th in Seattle and lands on the 14th in Tokyo, so the next-morning
    // departure sits on the 15th's board. Keying off the departure date fetched
    // the 13th and 14th and silently missed every Tokyo overnight — precisely
    // the routing this tool exists to find. It only appeared to work for
    // Vancouver, where no date line is involved.
    const needed = new Map(); // gateway -> Set of local board dates
    for (const f of outbound) {
      const gateway = gateways.find((g) => g.via === f.destination);
      if (!gateway?.viaTz) continue;
      const arrivalDate = localDate(f.arrivalUtc, gateway.viaTz);
      const dates = needed.get(f.destination) ?? new Set();
      dates.add(arrivalDate);              // a late-evening landing can pair pre-midnight
      dates.add(addDays(arrivalDate, 1));  // and the next morning, the usual case
      needed.set(f.destination, dates);
    }

    const onwardByGateway = new Map();
    let onwardFetches = 0;
    for (const [gw, dates] of needed) {
      const flights = [];
      for (const d of [...dates].sort()) {
        onwardFetches += opt.windows.length;
        flights.push(...await fetchDay(source, gw, d, opt.windows));
      }
      onwardByGateway.set(gw, flights.filter((f) => f.destination === destination && f.departureUtc));
    }

    // ── 3. Pair and evaluate ────────────────────────────────────────────────
    const candidates = [];
    for (const leg1 of outbound) {
      const gateway = gateways.find((g) => g.via === leg1.destination);
      if (!gateway?.viaTz) continue;

      for (const leg2 of onwardByGateway.get(leg1.destination) ?? []) {
        // NFR-1: UTC instants only. Never local clock arithmetic.
        const layover = classifyLayover(leg1.arrivalUtc, leg2.departureUtc, gateway.viaTz);
        if (!layover.valid) continue;

        const hours = layover.minutes / 60;
        if (hours < opt.minLayoverHours || hours > opt.maxLayoverHours) continue;

        const ticketability = network.ticketability(leg1.carrier, leg2.carrier);
        if (opt.onlySameCarrier && ticketability.status !== 'same') continue;

        const program = network.matchStopoverProgram(leg1.carrier, leg1.destination, layover, true);

        // Entry rules are evaluated against the LAYOVER date, not today.
        //
        // The country code comes off the airport record (added at build time
        // from OpenFlights' own country file). It used to come from a short
        // hand-written map in this file, which silently skipped the check for
        // any country missing from it — a live search through Vancouver and
        // Beijing printed no entry advice at all, which reads as "fine" rather
        // than "not checked". Now an unmapped country still produces a result,
        // and that result is 'unknown'.
        let entry = null;
        let entryChange = null;
        if (entryRules && layover.isOvernight) {
          const layoverDate = layover.departureLocal.date;
          const cc = network.airport(gateway.via)?.countryCode ?? null;
          entry = cc
            ? entryRules.evaluate(opt.passport, cc, layoverDate)
            : { status: 'unknown', countryCode: null, countryName: gateway.viaCountry,
                confidence: 'none', sources: [], verifyBeforeTravel: true, arrivalFormalities: [],
                note: 'No ISO country code for this airport, so entry rules could not be looked up.' };
          entryChange = cc ? entryRules.upcomingChange(opt.passport, cc, layoverDate, 180) : null;
        }

        // Will the bag follow you? The 24-hour line governs this too, except on
        // US carriers, which cap it around 12h.
        const baggage = baggageRules
          ? baggageRules.throughCheck(leg1.carrier, layover.minutes / 60,
            { gatewayCountry: network.airport(gateway.via)?.countryCode ?? null })
          : null;

        candidates.push({
          origin,
          destination,
          gateway: gateway.via,
          gatewayCity: gateway.viaCity,
          gatewayCountry: gateway.viaCountry,
          detourRatio: gateway.detourRatio,
          leg1,
          leg2,
          layover,
          usableCityHours: usableCityHours(leg1.arrivalUtc, leg2.departureUtc, gateway.viaTz),
          ticketability,
          program,
          entry,
          entryChange,
          baggage,
        });
      }
    }

    candidates.sort((a, b) => score(a) - score(b));
    return {
      candidates,
      gateways,
      reason: candidates.length ? null : 'no-pairings-in-window',
      apiCalls: perDay + onwardFetches,
    };
  }

  return { findOvernightCandidates };
}

/**
 * Lower is better: ticketable first, then a stopover programme, then usable
 * hours, then directness.
 *
 * The detour term had an operator-precedence bug. `c.detourRatio ?? 1.5 - 1`
 * parses as `c.detourRatio ?? (1.5 - 1)` because ?? binds looser than -, so the
 * subtraction only ever applied to the fallback and every candidate carried a
 * constant ~20-point penalty proportional to its raw ratio rather than to its
 * excess over a nonstop. Parenthesised properly, a direct routing scores 0.
 */
function score(c) {
  const tkt = { same: 0, alliance: 1, unknown: 2 }[c.ticketability.status] * 100;
  const programme = c.program?.highlights?.some((h) => h.kind === 'free_stopover'
    || h.kind === 'transit_tour') ? -25 : 0;
  const usable = -Math.min(c.usableCityHours, 12) * 4;
  const detour = ((c.detourRatio ?? 1.5) - 1) * 20;
  return tkt + programme + usable + detour;
}

export { score as _scoreForTests };
