#!/usr/bin/env node
/**
 * End-to-end demo of the P1 pipeline, using FIXTURE flight times.
 *
 *   node scripts/demo.mjs            # or: npm run demo
 *
 * Everything here is real except the departure and arrival times:
 *   - the gateways come from the actual route graph (data/routes.json)
 *   - the timezones come from the actual airport table (data/airports.json)
 *   - the stopover programmes come from the actual curated table
 *   - the layover maths is the real engine
 *
 * The flight times are invented, because the schedule source is still gated on
 * the P0 probe (scripts/schedule-source-test.mjs). They are plausible rather
 * than real, and are labelled as such in the output so nobody mistakes this for
 * a bookable itinerary.
 *
 * Swapping in live data is one function: replace getDeparturesFixture() with a
 * real getDepartures(airport, date). Nothing else in the pipeline changes.
 */

import { network, PROGRAMS_CHECKED_AT } from '../src/engine/data-node.mjs';
import { classifyLayover, usableCityHours, describeLayover, formatMinutes, localParts } from '../src/engine/index.mjs';

const { findGateways, airport, ticketability, matchStopoverProgram } = network;

const ORIGIN = process.env.ORIGIN ?? 'SEA';
const DEST = process.env.DEST ?? 'ICN';

/** Plausible-but-invented schedules, keyed origin-gateway-destination. */
const FIXTURES = {
  'SEA-NRT-ICN': {
    leg1: { carrier: 'NH', number: 'NH 177', departUtc: '2026-10-12T20:35:00Z', arriveUtc: '2026-10-13T07:25:00Z' },
    leg2: { carrier: 'NH', number: 'NH 867', departUtc: '2026-10-14T00:00:00Z', arriveUtc: '2026-10-14T02:35:00Z' },
  },
  'SEA-TPE-ICN': {
    leg1: { carrier: 'BR', number: 'BR 025', departUtc: '2026-10-12T21:20:00Z', arriveUtc: '2026-10-13T10:20:00Z' },
    leg2: { carrier: 'BR', number: 'BR 160', departUtc: '2026-10-14T00:50:00Z', arriveUtc: '2026-10-14T03:20:00Z' },
  },
  'SEA-PVG-ICN': {
    leg1: { carrier: 'MU', number: 'MU 298', departUtc: '2026-10-12T19:10:00Z', arriveUtc: '2026-10-13T08:40:00Z' },
    leg2: { carrier: 'OZ', number: 'OZ 362', departUtc: '2026-10-13T23:30:00Z', arriveUtc: '2026-10-14T01:20:00Z' },
  },
};

const getDeparturesFixture = (key) => FIXTURES[key] ?? null;

const local = (iso, tz) => {
  const p = localParts(new Date(iso), tz);
  return `${p.date} ${p.time}`;
};

function buildCandidate(gateway) {
  const key = `${gateway.origin}-${gateway.via}-${gateway.destination}`;
  const fx = getDeparturesFixture(key);
  if (!fx) return null;

  const tz = gateway.viaTz;
  const arrival = new Date(fx.leg1.arriveUtc);
  const departure = new Date(fx.leg2.departUtc);

  const layover = classifyLayover(arrival, departure, tz);
  const usable = usableCityHours(arrival, departure, tz);
  const tkt = ticketability(fx.leg1.carrier, fx.leg2.carrier);
  const program = matchStopoverProgram(fx.leg1.carrier, gateway.via, layover, true);

  return { gateway, fx, layover, usable, tkt, program, tz };
}

function render(c) {
  const { gateway: g, fx, layover, usable, tkt, program, tz } = c;
  const o = airport(g.origin);
  const v = airport(g.via);
  const d = airport(g.destination);

  console.log(`\n${'─'.repeat(74)}`);
  console.log(`  ${g.origin} → ${g.via} → ${g.destination}   via ${v.city}`);
  console.log(`  ${describeLayover(layover).toUpperCase()} · ${formatMinutes(layover.minutes)} on the ground`);
  console.log(`${'─'.repeat(74)}`);

  console.log(`  leg 1  ${fx.leg1.number.padEnd(8)} ${g.origin} ${local(fx.leg1.departUtc, o.tz)}`
    + `  →  ${g.via} ${local(fx.leg1.arriveUtc, tz)}`);
  console.log(`         ${' '.repeat(8)} ${describeNight(layover, usable)}`);
  console.log(`  leg 2  ${fx.leg2.number.padEnd(8)} ${g.via} ${local(fx.leg2.departUtc, tz)}`
    + `  →  ${g.destination} ${local(fx.leg2.arriveUtc, d.tz)}`);

  console.log(`\n  ticketing   ${tkt.note}`);
  console.log(`  detour      ${g.detourRatio.toFixed(2)}× the nonstop distance`);
  console.log(`  usable      ~${usable.toFixed(1)}h in ${v.city} after immigration, transfers and sleep`);

  if (program) {
    for (const h of program.highlights) {
      const marker = h.kind === 'hotel_disqualified' ? '  ⚠ '
        : h.kind === 'below_stopover_threshold' ? '  · '
          : '  ★ ';
      console.log(`${marker}${h.text}`);
    }
    console.log(`     (${program.carrierName}, ${program.confidence} confidence, checked ${PROGRAMS_CHECKED_AT} — verify with the carrier)`);
  }

  console.log(`\n  → Confirm price and availability in ${fx.leg1.carrier}'s multi-city search.`);
}

function describeNight(layover, usable) {
  if (!layover.isOvernight) return `${formatMinutes(layover.minutes)} layover`;
  const nights = layover.nightsRequired === 1 ? 'one night' : `${layover.nightsRequired} nights`;
  return `overnight — ${nights} on the ground, ~${usable.toFixed(1)}h usable`;
}

console.log('Layover Finder — P1 pipeline demo');
console.log('═'.repeat(74));
console.log(`  route graph    data/routes.json (OpenFlights, stale — candidate pre-filter only)`);
console.log(`  schedules      FIXTURES — invented, plausible times. NOT bookable.`);
console.log(`  everything else is the real engine and the real curated data.`);

const gateways = findGateways(ORIGIN, DEST, { limit: 12, onlySameCarrier: false });
console.log(`\n  ${gateways.length} candidate gateways from the route graph; showing those with fixture schedules.`);

const candidates = gateways.map(buildCandidate).filter(Boolean);

if (!candidates.length) {
  console.log('\n  No fixtures for these gateways. Set ORIGIN/DEST to SEA/ICN, or add a fixture.');
} else {
  candidates
    .sort((a, b) => b.usable - a.usable)
    .forEach(render);
}

console.log(`\n${'═'.repeat(74)}`);
console.log('  Swap getDeparturesFixture() for a live getDepartures(airport, date) and');
console.log('  this becomes real. That is the whole remaining dependency for P1.\n');
