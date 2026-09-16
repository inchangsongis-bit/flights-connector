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
import { localDate, localParts } from './time.mjs';

/**
 * Exactly the (date, window) boards that could hold a qualifying leg-2 departure.
 *
 * Fetching the arrival day and the next in full was wasteful in a way that
 * matters on a metered tier: a flight landing at 16:25 with an 8-hour minimum
 * layover cannot pair with anything until 00:25 the following day, so the whole
 * arrival-day board — two calls — was guaranteed to contain nothing.
 *
 * The usable leg-2 departures lie in [arrival + min, arrival + max]. Rather than
 * convert those bounds back to local wall-clock — the direction that is
 * ambiguous across DST — walk the interval and record which local (date, window)
 * each sampled instant lands in. Sampling has no DST failure mode, and a
 * half-hour step cannot skip a 12-hour window.
 */
function boardsNeeded(arrival, tz, windows, minHours, maxHours, stepMinutes = 30) {
  const needed = new Set();
  const from = arrival.getTime() + minHours * 3600000;
  const to = arrival.getTime() + maxHours * 3600000;
  for (let t = from; t <= to + stepMinutes * 60000; t += stepMinutes * 60000) {
    const p = localParts(new Date(Math.min(t, to)), tz);
    for (let i = 0; i < windows.length; i += 1) {
      const [fromHour, toHour] = windows[i];
      if (p.hour >= fromHour && p.hour < Math.min(toHour, 24)) needed.add(`${p.date}|${i}`);
    }
    if (t >= to) break;
  }
  return [...needed].map((k) => {
    const [date, i] = k.split('|');
    return { date, window: windows[Number(i)] };
  });
}

/** One board, deduped — a vendor may return a boundary flight in two windows. */
async function fetchBoard(source, airport, date, window, seen, out) {
  const [fromHour, toHour] = window;
  const flights = await source.getDepartures(airport, date, { fromHour, toHour });
  for (const f of flights) {
    const key = `${f.flightNumber}@${f.departureUtc?.getTime() ?? '?'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
}

async function fetchDay(source, airport, date, windows) {
  const seen = new Set();
  const out = [];
  for (const window of windows) await fetchBoard(source, airport, date, window, seen, out);
  return out;
}

const DEFAULT = {
  maxGateways: 3,
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
  /** Cap per gateway. 150 raw pairings is leg1 x leg2 combinatorics, not 150 choices. */
  perGateway: 3,
  /** Refuse to start a search that would cost more than this many calls. */
  maxApiCalls: 24,
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
export function createSearch({ source, network, entryRules = null, baggageRules = null, bookingLinks = null }) {
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
    const originBoard = await fetchDay(source, origin, date, opt.windows);

    // The nonstop comparison is FREE: it is already on the board we just paid
    // for. Without it the app can show a routing but not answer the question
    // that actually decides a trip — is the detour worth it?
    const destinations = new Set(network.expandToAirports(destination));
    const nonstops = originBoard
      .filter((f) => destinations.has(f.destination) && f.arrivalUtc && f.departureUtc)
      .map((f) => ({
        carrier: f.carrier,
        flightNumber: f.flightNumber,
        destination: f.destination,
        departureUtc: f.departureUtc,
        arrivalUtc: f.arrivalUtc,
        departureLocal: f.departureLocal,
        arrivalLocal: f.arrivalLocal,
        minutes: (f.arrivalUtc - f.departureUtc) / 60000,
      }))
      .sort((a, b) => a.minutes - b.minutes);
    const nonstop = nonstops[0] ?? null;

    const outbound = originBoard.filter((f) => wanted.has(f.destination) && f.arrivalUtc);

    if (!outbound.length) {
      return { candidates: [], gateways, nonstop, nonstops, reason: 'no-outbound-flights', apiCalls: perDay };
    }

    // Which gateway boards to fetch, derived from each leg's actual arrival
    // instant and the layover band — not from the origin's departure date.
    //
    // Two things go wrong with the naive version. Crossing the date line breaks
    // it outright: SEA→NRT leaves on the 13th in Seattle and lands on the 14th
    // in Tokyo, so the next-morning departure sits on the 15th's board. And
    // fetching whole days wastes calls on boards that cannot hold a qualifying
    // flight at all.
    const plan = new Map(); // gateway -> Map of "date|windowIndex" -> {date, window}
    for (const f of outbound) {
      const gateway = gateways.find((g) => g.via === f.destination);
      if (!gateway?.viaTz) continue;
      const boards = boardsNeeded(f.arrivalUtc, gateway.viaTz, opt.windows,
        opt.minLayoverHours, opt.maxLayoverHours);
      const forGateway = plan.get(f.destination) ?? new Map();
      for (const b of boards) forGateway.set(`${b.date}|${b.window.join('-')}`, b);
      plan.set(f.destination, forGateway);
    }

    const plannedFetches = [...plan.values()].reduce((n, m) => n + m.size, 0);
    const estimate = perDay + plannedFetches;
    const budget = { estimate, limit: opt.maxApiCalls, gatewaysPlanned: plan.size, spentSoFar: perDay };

    // The plan is only knowable after the origin board, so the guard runs here
    // rather than up front. Stopping with two calls spent beats discovering the
    // cost after twenty.
    if (estimate > opt.maxApiCalls) {
      return { candidates: [], gateways, reason: 'over-budget', apiCalls: perDay, budget };
    }
    if (opt.onPlan) opt.onPlan(budget);
    if (opt.dryRun) {
      return { candidates: [], gateways, nonstop, nonstops, reason: 'dry-run', apiCalls: perDay, budget,
        plan: [...plan.entries()].map(([gw, boards]) => ({
          gateway: gw, boards: [...boards.values()].map((b) => `${b.date} ${b.window.join('-')}`),
        })) };
    }

    const onwardByGateway = new Map();
    let onwardFetches = 0;
    for (const [gw, boards] of plan) {
      const seen = new Set();
      const flights = [];
      for (const { date: d, window } of [...boards.values()].sort((a, b) => a.date.localeCompare(b.date))) {
        onwardFetches += 1;
        await fetchBoard(source, gw, d, window, seen, flights);
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
          // The plain answer ("Visa-free for up to 90 days"), separate from the
          // rule's caveat. Displaying the caveat alone reads as a non-answer.
          entry.summary = entryRules.describe(entry);
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
          // What the detour actually costs in time, against the fastest nonstop
          // on the same day. Null when no nonstop exists — which is itself worth
          // knowing, since then the layover is not a choice but the only way.
          vsNonstop: nonstop ? {
            nonstopMinutes: nonstop.minutes,
            nonstopCarrier: nonstop.carrier,
            nonstopFlight: nonstop.flightNumber,
            totalMinutes: (leg2.arrivalUtc ?? leg2.departureUtc) - leg1.departureUtc >= 0
              ? ((leg2.arrivalUtc ?? leg2.departureUtc) - leg1.departureUtc) / 60000
              : null,
          } : null,
          booking: null, // filled below, once origin/destination are known on the object
        });
      }
    }

    for (const c of candidates) {
      if (c.vsNonstop?.totalMinutes != null) {
        c.vsNonstop.extraMinutes = c.vsNonstop.totalMinutes - c.vsNonstop.nonstopMinutes;
      }
      // Booking links need the finished candidate (origin, gateway, destination).
      if (bookingLinks) c.booking = bookingLinks.forCandidate(c);
    }

    candidates.sort((a, b) => score(a) - score(b));

    // Cap per gateway. The raw list is leg1 x leg2 combinatorics — a live search
    // returned 150 pairings across four cities, which is not 150 choices.
    const kept = [];
    const perGatewayCount = new Map();
    let trimmed = 0;
    for (const c of candidates) {
      const n = perGatewayCount.get(c.gateway) ?? 0;
      if (n >= opt.perGateway) { trimmed += 1; continue; }
      perGatewayCount.set(c.gateway, n + 1);
      kept.push(c);
    }

    return {
      candidates: kept,
      allCandidates: candidates,
      trimmed,
      perGateway: Object.fromEntries(perGatewayCount),
      nonstop,
      nonstops,
      gateways,
      reason: candidates.length ? null : 'no-pairings-in-window',
      apiCalls: perDay + onwardFetches,
      budget,
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
