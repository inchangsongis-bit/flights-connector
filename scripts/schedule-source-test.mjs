#!/usr/bin/env node
/**
 * Schedule-source acceptance test — the $0 path.
 *
 * WHY THIS EXISTS
 * ───────────────
 * No free source of *sold itineraries* exists (Amadeus is gated, Duffel needs a
 * funded account, Kiwi is invite-only, Travelpayouts' search API needs 50k MAU).
 *
 * But a multi-city stopover — SEA→HND on day D, HND→ICN on day D+1 — is a single
 * ticket assembled from two explicit origin-destinations. The airline's maximum
 * connect time does not apply, because the stopover is *requested*, not a
 * connection the engine has to construct. So we can build candidates from plain
 * schedule data, as long as:
 *
 *   1. both flights actually operate on those dates   → this API
 *   2. the carriers can be ticketed together          → same carrier / alliance
 *
 * and then hand off to the airline's own multi-city search to price and confirm.
 *
 * THE GATING QUESTION
 * ───────────────────
 * Many aviation APIs are strong on *live status* and weak on *forward schedules*.
 * If this source only reaches a few days out it is useless for trip planning, and
 * no amount of clever assembly fixes that. Test 1 answers it before anything else.
 *
 * Usage:
 *   export RAPIDAPI_KEY=...            # rapidapi.com → AeroDataBox → subscribe (Basic, free)
 *   node scripts/schedule-source-test.mjs            # probe + assemble
 *   node scripts/schedule-source-test.mjs --probe    # probe only (cheapest, 5 calls)
 *
 * Node 18+. No dependencies.
 *
 * QUOTA WARNING: the free Basic tier is ~600 units/month and each call costs
 * several units. Full run is ~8 calls. Use --probe while iterating.
 */

const KEY = process.env.RAPIDAPI_KEY;
const HOST = 'aerodatabox.p.rapidapi.com';
const PROBE_ONLY = process.argv.includes('--probe');

const ORIGIN = process.env.ORIGIN ?? 'SEA';
const DEST = process.env.DEST ?? 'ICN';
const GATEWAYS = (process.env.GATEWAYS ?? 'HND,NRT,KIX,TPE').split(',');
const DAYS_OUT = Number(process.env.DAYS_OUT ?? 28);

const MIN_LAYOVER_HOURS = 8;   // docs/01-requirements.md §2.1 — MIN_OVERNIGHT_HOURS
const MAX_LAYOVER_HOURS = 36;

if (!KEY) {
  console.error('Missing RAPIDAPI_KEY.\n');
  console.error('Get one free: rapidapi.com → search "AeroDataBox" → Subscribe → Basic ($0).');
  console.error('No credit card required for the Basic tier.');
  process.exit(2);
}

const isoDate = (days) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const fmt = (mins) => `${Math.floor(mins / 60)}h ${String(Math.round(mins % 60)).padStart(2, '0')}m`;

let callCount = 0;

/**
 * AeroDataBox FIDS: departures for an airport within a local time window.
 * Window is capped at 12h per request, so a full day costs two calls.
 * NOTE: the endpoint shape below is unverified from this environment — if it
 * 404s, check doc.aerodatabox.com and adjust the path here only.
 */
async function departures(iata, date, fromHour, toHour) {
  const from = `${date}T${String(fromHour).padStart(2, '0')}:00`;
  const to = `${date}T${String(toHour).padStart(2, '0')}:00`;
  const url = `https://${HOST}/flights/airports/iata/${iata}/${from}/${to}`
    + `?direction=Departure&withLeg=true&withCancelled=false&withCodeshared=false`
    + `&withCargo=false&withPrivate=false&withLocation=false`;

  callCount += 1;
  const res = await fetch(url, { headers: { 'x-rapidapi-key': KEY, 'x-rapidapi-host': HOST } });

  if (res.status === 429) throw new Error('Rate limited / quota exhausted (429). Free tier units spent.');
  if (res.status === 403) throw new Error('403 — key not subscribed to AeroDataBox on RapidAPI.');
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`);

  const body = await res.json();
  return (body.departures ?? []).map((f) => ({
    number: f.number,
    airline: f.airline?.name,
    airlineIata: f.airline?.iata,
    to: f.movement?.airport?.iata ?? f.arrival?.airport?.iata,
    toName: f.movement?.airport?.name ?? f.arrival?.airport?.name,
    // AeroDataBox returns BOTH utc and local — exactly what NFR-1 needs.
    departUtc: f.departure?.scheduledTime?.utc ?? f.movement?.scheduledTime?.utc,
    departLocal: f.departure?.scheduledTime?.local ?? f.movement?.scheduledTime?.local,
    arriveUtc: f.arrival?.scheduledTime?.utc ?? f.movement?.scheduledTime?.utc,
    arriveLocal: f.arrival?.scheduledTime?.local ?? f.movement?.scheduledTime?.local,
  }));
}

/** Parse AeroDataBox's "2026-10-03 15:20+09:00" into a Date. */
const parseTs = (s) => (s ? new Date(s.replace(' ', 'T')) : null);

// ── Test 1 — forward schedule range (the gating question) ──────────────────
async function probeForwardRange() {
  console.log(`\n${'─'.repeat(72)}`);
  console.log('TEST 1 — How far ahead do forward schedules actually go?');
  console.log('  This gates everything. A source that stops at +7d cannot plan a trip.');
  console.log(`${'─'.repeat(72)}`);

  const horizons = [7, 14, 28, 60, 90];
  const results = [];

  for (const days of horizons) {
    const date = isoDate(days);
    try {
      const flights = await departures(ORIGIN, date, 6, 18);
      const ok = flights.length > 0;
      results.push({ days, date, count: flights.length, ok });
      console.log(`  +${String(days).padStart(3)}d  ${date}   ${ok ? 'OK  ' : 'EMPTY'}  ${flights.length} departures from ${ORIGIN}`);
    } catch (err) {
      results.push({ days, date, count: 0, ok: false, error: err.message });
      console.log(`  +${String(days).padStart(3)}d  ${date}   ERROR  ${err.message}`);
    }
  }

  const furthest = results.filter((r) => r.ok).pop();
  console.log('');
  if (!furthest) {
    console.log('  VERDICT: FAIL — no forward schedules at any horizon.');
    console.log('  This source cannot support trip planning. See docs/03-data-sources.md.');
  } else if (furthest.days >= 28) {
    console.log(`  VERDICT: PASS — schedules reach at least +${furthest.days} days.`);
    console.log('  Enough for real trip planning. Proceed.');
  } else {
    console.log(`  VERDICT: WEAK — schedules only reach +${furthest.days} days.`);
    console.log('  Usable for near-term trips only. Note the limit prominently in the UI,');
    console.log('  or find a source with deeper forward coverage.');
  }
  return furthest;
}

// ── Test 2 — assemble a real overnight stopover candidate ──────────────────
async function assembleStopover() {
  const dayOut = isoDate(DAYS_OUT);
  const dayNext = isoDate(DAYS_OUT + 1);

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`TEST 2 — Assemble: ${ORIGIN} → [${GATEWAYS.join('/')}] → ${DEST}, overnight`);
  console.log(`  out ${dayOut}, onward ${dayNext}`);
  console.log(`${'─'.repeat(72)}`);

  // Leg 1: departures from origin heading to any candidate gateway.
  const outbound = (await departures(ORIGIN, dayOut, 6, 18))
    .filter((f) => GATEWAYS.includes(f.to));

  if (!outbound.length) {
    console.log(`\n  No ${ORIGIN} departures to ${GATEWAYS.join('/')} found in the 06:00–18:00 window.`);
    console.log('  Try a wider window, other GATEWAYS, or another DAYS_OUT.');
    return;
  }

  console.log(`\n  Leg 1 — ${outbound.length} flight(s) from ${ORIGIN} to a candidate gateway:`);
  for (const f of outbound) {
    console.log(`    ${f.airlineIata ?? '??'} ${f.number}  → ${f.to}  dep ${f.departLocal}  arr ${f.arriveLocal}`);
  }

  // Leg 2: next-day departures from each gateway actually reached.
  const reached = [...new Set(outbound.map((f) => f.to))];
  const candidates = [];

  for (const gw of reached) {
    const onward = (await departures(gw, dayNext, 6, 18)).filter((f) => f.to === DEST);
    for (const leg1 of outbound.filter((f) => f.to === gw)) {
      for (const leg2 of onward) {
        const arr = parseTs(leg1.arriveUtc ?? leg1.arriveLocal);
        const dep = parseTs(leg2.departUtc ?? leg2.departLocal);
        if (!arr || !dep) continue;
        // NFR-1: layover computed from UTC instants, never from local clock times.
        const layoverMin = (dep - arr) / 60000;
        if (layoverMin < MIN_LAYOVER_HOURS * 60 || layoverMin > MAX_LAYOVER_HOURS * 60) continue;
        candidates.push({ gw, leg1, leg2, layoverMin, sameCarrier: leg1.airlineIata === leg2.airlineIata });
      }
    }
  }

  console.log(`\n${'═'.repeat(72)}`);
  if (!candidates.length) {
    console.log(`  No overnight candidates in the ${MIN_LAYOVER_HOURS}–${MAX_LAYOVER_HOURS}h band.`);
    console.log('  Widen the window or try other gateways.');
    return;
  }

  console.log(`  ${candidates.length} OVERNIGHT STOPOVER CANDIDATE(S)\n`);
  for (const c of candidates.sort((a, b) => a.layoverMin - b.layoverMin)) {
    const tag = c.sameCarrier
      ? 'same carrier — ticketable as one multi-city booking'
      : 'DIFFERENT carriers — needs an interline/alliance check before this is one ticket';
    console.log(`  ${ORIGIN} → ${c.gw} → ${DEST}   layover ${fmt(c.layoverMin)}`);
    console.log(`    leg 1  ${c.leg1.airlineIata} ${c.leg1.number}  dep ${c.leg1.departLocal}  arr ${c.leg1.arriveLocal}`);
    console.log(`    leg 2  ${c.leg2.airlineIata} ${c.leg2.number}  dep ${c.leg2.departLocal}  arr ${c.leg2.arriveLocal}`);
    console.log(`    ${tag}`);
    if (c.sameCarrier && ['NH', 'JL'].includes(c.leg1.airlineIata)) {
      console.log(`    ${c.leg1.airlineIata === 'NH' ? 'ANA' : 'JAL'}: first stopover in Japan is free per direction.`);
    }
    console.log('');
  }
  console.log('  Next: confirm price and ticketing in the carrier\'s own multi-city search.');
}

async function main() {
  console.log('Schedule-source acceptance test — the $0 path');
  console.log('═'.repeat(72));
  console.log(`  source:  AeroDataBox (RapidAPI, Basic/free tier)`);
  console.log(`  route:   ${ORIGIN} → [${GATEWAYS.join('/')}] → ${DEST}`);

  const range = await probeForwardRange();
  if (PROBE_ONLY) {
    console.log(`\n  (--probe: stopping here. ${callCount} API calls used.)\n`);
    return;
  }
  if (!range) {
    console.log('\n  Skipping Test 2 — no forward schedules available.\n');
    return;
  }
  await assembleStopover();
  console.log(`\n  ${callCount} API calls used this run.\n`);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  console.error(`(${callCount} API calls used before failure.)\n`);
  process.exit(1);
});
