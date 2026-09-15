#!/usr/bin/env node
/**
 * AeroDataBox acceptance test.
 *
 *   node scripts/schedule-source-test.mjs --probe   # forward range only (5 calls)
 *   node scripts/schedule-source-test.mjs --shape   # settle the field mapping (1 call)
 *   node scripts/schedule-source-test.mjs           # probe + assemble (~8 calls)
 *
 *   export RAPIDAPI_KEY=...       # rapidapi.com → AeroDataBox → Subscribe → Basic ($0)
 *
 * TEST 1 — forward range. PASSED 2026-09-15: schedules reach at least +90 days,
 * 400+ departures a day from SEA. That was the gate on the whole project.
 *
 * TEST 2 — field mapping. The probe counted flights but never looked inside one,
 * so the per-field paths in src/adapters/aerodatabox.mjs are still inferred.
 * --shape resolves every field against a real record and reports which candidate
 * path won, so one call settles it.
 *
 * TEST 3 — assembly. Builds a real overnight candidate end to end.
 *
 * Node 20.11+. No dependencies.
 *
 * QUOTA: the free Basic tier is ~600 units/month and each call costs several.
 */

import { createAeroDataBoxSource, describeShape } from '../src/adapters/aerodatabox.mjs';

const KEY = process.env.RAPIDAPI_KEY;
const MODE = process.argv.includes('--probe') ? 'probe'
  : process.argv.includes('--shape') ? 'shape' : 'full';

const ORIGIN = process.env.ORIGIN ?? 'SEA';
const DEST = process.env.DEST ?? 'ICN';
const GATEWAYS = (process.env.GATEWAYS ?? 'HND,NRT,KIX,TPE').split(',');
const DAYS_OUT = Number(process.env.DAYS_OUT ?? 28);

const MIN_LAYOVER_HOURS = 8;
const MAX_LAYOVER_HOURS = 36;

if (!KEY) {
  console.error('Missing RAPIDAPI_KEY.\n');
  console.error('rapidapi.com → search "AeroDataBox" → Subscribe → Basic ($0, no card).');
  console.error('Subscribing to RapidAPI is not enough — it is per-API.');
  process.exit(2);
}

const isoDate = (days) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const fmt = (m) => `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m`;

let calls = 0;
const source = createAeroDataBoxSource({
  apiKey: KEY,
  fetchImpl: (...args) => { calls += 1; return fetch(...args); },
});

// ── Test 1 — forward range ──────────────────────────────────────────────────
async function probeForwardRange() {
  console.log(`\n${'─'.repeat(72)}`);
  console.log('TEST 1 — How far ahead do forward schedules actually go?');
  console.log('  Gates everything. A source that stops at +7d cannot plan a trip.');
  console.log('─'.repeat(72));

  const results = [];
  for (const days of [7, 14, 28, 60, 90]) {
    const date = isoDate(days);
    try {
      const flights = await source.getDepartures(ORIGIN, date, { fromHour: 6, toHour: 18 });
      results.push({ days, ok: flights.length > 0 });
      console.log(`  +${String(days).padStart(3)}d  ${date}   ${flights.length ? 'OK  ' : 'EMPTY'}  ${flights.length} departures from ${ORIGIN}`);
    } catch (err) {
      results.push({ days, ok: false });
      console.log(`  +${String(days).padStart(3)}d  ${date}   ERROR  ${err.message}`);
    }
  }

  const furthest = results.filter((r) => r.ok).pop();
  console.log('');
  if (!furthest) console.log('  VERDICT: FAIL — no forward schedules at any horizon.');
  else if (furthest.days >= 28) console.log(`  VERDICT: PASS — schedules reach at least +${furthest.days} days.`);
  else console.log(`  VERDICT: WEAK — only +${furthest.days} days. Near-term trips only.`);
  return furthest;
}

// ── Test 2 — field mapping ──────────────────────────────────────────────────
async function probeShape() {
  const date = isoDate(DAYS_OUT);
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`TEST 2 — Which field paths does the real response actually use?`);
  console.log(`  ${ORIGIN} departures on ${date}. Settles the adapter's inferred mapping.`);
  console.log('─'.repeat(72));

  const flights = await source.getDepartures(ORIGIN, date, { fromHour: 6, toHour: 18 });
  const shape = describeShape(flights);

  if (!flights.length) { console.log('\n  No flights returned — cannot inspect the shape.'); return shape; }

  console.log(`\n  ${flights.length} flights. Field paths that resolved:\n`);
  for (const [field, path] of Object.entries(shape.chosen)) {
    console.log(`    ${field.padEnd(20)} ${path}`);
  }
  if (shape.missing.length) {
    console.log(`\n  Resolved to nothing: ${shape.missing.join(', ')}`);
  }
  if (shape.criticalMissing.length) {
    console.log(`\n  ✗ CRITICAL fields missing: ${shape.criticalMissing.join(', ')}`);
    console.log('    The adapter cannot work until these map. Paste this output back.');
  }

  const c = shape.coverage;
  console.log(`\n  Coverage across all ${c.total} flights:`);
  console.log(`    carrier        ${c.withCarrier}/${c.total}`);
  console.log(`    destination    ${c.withDestination}/${c.total}`);
  console.log(`    departure UTC  ${c.withDepartureUtc}/${c.total}`);
  console.log(`    arrival UTC    ${c.withArrivalUtc}/${c.total}   ${c.withArrivalUtc < c.total ? '(partial arrival times are expected on a departure board)' : ''}`);

  const sample = flights.find((f) => f.carrier && f.destination && f.departureUtc);
  if (sample) {
    console.log(`\n  Sample flight:`);
    console.log(`    ${sample.carrier} ${sample.flightNumber} → ${sample.destination} (${sample.destinationName ?? '?'})`);
    console.log(`    departs ${sample.departureUtc.toISOString()}  local ${sample.departureLocal ?? '?'}`);
    console.log(`    arrives ${sample.arrivalUtc ? sample.arrivalUtc.toISOString() : 'not given'}`);
  }

  console.log(`\n  VERDICT: ${shape.ok ? 'PASS — the adapter maps this response correctly.' : 'FAIL — see critical fields above.'}`);
  return shape;
}

// ── Test 3 — assemble an overnight candidate ────────────────────────────────
async function assembleStopover() {
  const dayOut = isoDate(DAYS_OUT);
  const dayNext = isoDate(DAYS_OUT + 1);
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`TEST 3 — Assemble: ${ORIGIN} → [${GATEWAYS.join('/')}] → ${DEST}, overnight`);
  console.log(`  out ${dayOut}, onward ${dayNext}`);
  console.log('─'.repeat(72));

  const outbound = (await source.getDepartures(ORIGIN, dayOut, { fromHour: 6, toHour: 18 }))
    .filter((f) => GATEWAYS.includes(f.destination));

  if (!outbound.length) {
    console.log(`\n  No ${ORIGIN} departures to ${GATEWAYS.join('/')} in the 06:00–18:00 window.`);
    console.log('  Try a wider window, other GATEWAYS, or another DAYS_OUT.');
    return;
  }

  console.log(`\n  Leg 1 — ${outbound.length} flight(s) to a candidate gateway:`);
  for (const f of outbound) {
    console.log(`    ${(f.carrier ?? '??').padEnd(3)} ${String(f.flightNumber).padEnd(9)} → ${f.destination}  `
      + `dep ${f.departureLocal ?? f.departureUtc?.toISOString()}`);
  }

  const candidates = [];
  for (const gw of [...new Set(outbound.map((f) => f.destination))]) {
    const onward = (await source.getDepartures(gw, dayNext, { fromHour: 6, toHour: 18 }))
      .filter((f) => f.destination === DEST);
    for (const leg1 of outbound.filter((f) => f.destination === gw)) {
      for (const leg2 of onward) {
        if (!leg1.arrivalUtc || !leg2.departureUtc) continue;
        // NFR-1: layover from UTC instants, never local clock times.
        const mins = (leg2.departureUtc - leg1.arrivalUtc) / 60000;
        if (mins < MIN_LAYOVER_HOURS * 60 || mins > MAX_LAYOVER_HOURS * 60) continue;
        candidates.push({ gw, leg1, leg2, mins, same: leg1.carrier === leg2.carrier });
      }
    }
  }

  console.log(`\n${'═'.repeat(72)}`);
  if (!candidates.length) {
    console.log(`  No overnight candidates in the ${MIN_LAYOVER_HOURS}–${MAX_LAYOVER_HOURS}h band.`);
    console.log('  If leg 1 arrival times were missing above, that is the cause — the');
    console.log('  departure board may not carry arrival times for the onward airport.');
    return;
  }

  console.log(`  ${candidates.length} OVERNIGHT CANDIDATE(S)\n`);
  for (const c of candidates.sort((a, b) => a.mins - b.mins)) {
    console.log(`  ${ORIGIN} → ${c.gw} → ${DEST}   layover ${fmt(c.mins)}`);
    console.log(`    leg 1  ${c.leg1.carrier} ${c.leg1.flightNumber}  arr ${c.leg1.arrivalLocal ?? c.leg1.arrivalUtc?.toISOString()}`);
    console.log(`    leg 2  ${c.leg2.carrier} ${c.leg2.flightNumber}  dep ${c.leg2.departureLocal ?? c.leg2.departureUtc?.toISOString()}`);
    console.log(`    ${c.same ? 'same carrier — ticketable as one multi-city booking' : 'DIFFERENT carriers — needs an interline/alliance check'}\n`);
  }
  console.log("  Next: confirm price and ticketing in the carrier's own multi-city search.");
}

async function main() {
  console.log('AeroDataBox acceptance test');
  console.log('═'.repeat(72));
  console.log(`  route:  ${ORIGIN} → [${GATEWAYS.join('/')}] → ${DEST}`);
  console.log(`  mode:   ${MODE}`);

  if (MODE === 'shape') { await probeShape(); }
  else {
    const range = await probeForwardRange();
    if (MODE === 'full' && range) { await probeShape(); await assembleStopover(); }
  }
  console.log(`\n  ${calls} API call(s) used.\n`);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  console.error(`(${calls} API call(s) used before failure.)\n`);
  process.exit(1);
});
