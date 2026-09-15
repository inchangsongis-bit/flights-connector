#!/usr/bin/env node
/**
 * Live overnight-layover search. The P1 pipeline, end to end, on real schedules.
 *
 *   RAPIDAPI_KEY=... node scripts/find.mjs SEA ICN 2026-10-13
 *   RAPIDAPI_KEY=... npm run find -- SEA ICN 2026-10-13 --passport=GB --same-carrier
 *
 * Options:
 *   --passport=XX     ISO alpha-2, default US — drives the entry/visa check
 *   --same-carrier    only routings one airline can ticket end to end
 *   --min=8 --max=36  layover band in hours
 *   --gateways=4      how many connection cities to price (each costs API calls)
 *   --no-cache        bypass the disk cache
 *
 * Results are CANDIDATES, not quotes: these flights operate on these dates and
 * the carrier can ticket them, but price, seat availability and fare rules are
 * confirmed in the carrier's own multi-city search.
 */

import { createAeroDataBoxSource } from '../src/adapters/aerodatabox.mjs';
import { withDiskCache } from '../src/adapters/cache.mjs';
import { createSearch } from '../src/engine/search.mjs';
import { network, entryRules, PROGRAMS_CHECKED_AT } from '../src/engine/data-node.mjs';
import { formatMinutes } from '../src/engine/time.mjs';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--'))
  .map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const [origin, destination, date] = args.filter((a) => !a.startsWith('--'));

if (!origin || !destination || !date) {
  console.error('Usage: node scripts/find.mjs <ORIGIN> <DEST> <YYYY-MM-DD> [options]');
  console.error('   e.g. node scripts/find.mjs SEA ICN 2026-10-13 --passport=US');
  process.exit(2);
}
if (!process.env.RAPIDAPI_KEY) {
  console.error('Missing RAPIDAPI_KEY. rapidapi.com → AeroDataBox → Subscribe → Basic ($0).');
  process.exit(2);
}

const raw = createAeroDataBoxSource({ apiKey: process.env.RAPIDAPI_KEY });
const source = flags['no-cache'] ? raw : withDiskCache({ source: raw, verbose: true });
const search = createSearch({ source, network, entryRules });

const O = network.airport(origin);
const D = network.airport(destination);

console.log(`\n${origin} → ${destination}   departing ${date}`);
console.log(`${O ? O.city : origin} to ${D ? D.city : destination}`);
console.log('─'.repeat(74));

let res;
try {
  res = await search.findOvernightCandidates(origin, destination, date, {
    passport: flags.passport ?? 'US',
    onlySameCarrier: Boolean(flags['same-carrier']),
    minLayoverHours: Number(flags.min ?? 8),
    maxLayoverHours: Number(flags.max ?? 36),
    maxGateways: Number(flags.gateways ?? 4),
  });
} catch (err) {
  // A failed lookup is an ordinary outcome here, not a crash. Say what happened
  // and what to do about it, without a stack trace.
  console.error(`\nSearch failed: ${err.message}`);
  if (/quota/i.test(err.message)) {
    console.error('The free tier resets monthly. Cached boards still work: re-run without --no-cache.');
  } else if (/egress proxy/i.test(err.message)) {
    console.error('Run this from a machine with unrestricted outbound HTTPS.');
  } else if (/not subscribed|403/i.test(err.message)) {
    console.error('Subscribe to AeroDataBox specifically on RapidAPI — Basic ($0). Account-level access is not enough.');
  }
  console.error('');
  process.exit(1);
}

console.log(`\nGateways considered (from the offline route graph, no API calls):`);
for (const g of res.gateways) {
  console.log(`  ${g.via}  ${(g.viaCity ?? '').padEnd(14)} ${g.detourRatio.toFixed(2)}×  `
    + `${g.ticketability.status}${g.stopoverPrograms.length ? `  [${g.stopoverPrograms.join(',')}]` : ''}`);
}

if (!res.candidates.length) {
  const why = {
    'no-gateways': 'No connection city in the route graph links these two within 1.5× the nonstop distance.',
    'no-outbound-flights': 'No flights from the origin to any candidate gateway in the search window, '
      + 'or they carry no arrival times. Try widening the window or another date.',
    'no-pairings-in-window': 'Flights exist on both legs, but no pairing falls inside the layover band. '
      + 'Try --min / --max, or the next day.',
  }[res.reason] ?? 'No candidates.';
  console.log(`\nNothing found. ${why}`);
} else {
  console.log(`\n${'═'.repeat(74)}`);
  console.log(`${res.candidates.length} OVERNIGHT CANDIDATE(S)`);

  for (const c of res.candidates) {
    const L = c.layover;
    console.log(`\n${'─'.repeat(74)}`);
    console.log(`  ${c.origin} → ${c.gateway} → ${c.destination}   via ${c.gatewayCity}`);
    console.log(`  ${L.isOvernight ? 'OVERNIGHT' : 'LAYOVER'} · ${formatMinutes(L.minutes)}`
      + `${L.nightsRequired ? ` · ${L.nightsRequired} night${L.nightsRequired > 1 ? 's' : ''}` : ''}`
      + ` · ~${c.usableCityHours.toFixed(1)}h usable in the city`);
    console.log('─'.repeat(74));
    console.log(`  leg 1  ${c.leg1.carrier} ${String(c.leg1.flightNumber).padEnd(9)} `
      + `dep ${c.leg1.departureLocal ?? c.leg1.departureUtc.toISOString()}`);
    console.log(`         ${' '.repeat(12)}arr ${c.leg1.arrivalLocal ?? c.leg1.arrivalUtc.toISOString()}`);
    console.log(`  leg 2  ${c.leg2.carrier} ${String(c.leg2.flightNumber).padEnd(9)} `
      + `dep ${c.leg2.departureLocal ?? c.leg2.departureUtc.toISOString()}`);
    console.log(`         ${' '.repeat(12)}arr ${c.leg2.arrivalLocal ?? c.leg2.arrivalUtc?.toISOString() ?? '?'}`);

    console.log(`\n  ticketing   ${c.ticketability.note}`);
    console.log(`  detour      ${c.detourRatio?.toFixed(2) ?? '?'}× the nonstop distance`);

    for (const h of c.program?.highlights ?? []) {
      const mark = h.kind === 'hotel_disqualified' ? '  ⚠' : h.kind === 'below_stopover_threshold' ? '  ·' : '  ★';
      console.log(`${mark} ${h.text}`);
    }
    if (c.entry) {
      const mark = c.entry.status === 'visa_free' ? '  ★' : c.entry.status === 'unknown' ? '  ⚠' : '  ·';
      console.log(`${mark} ${flags.passport ?? 'US'} passport → ${c.gatewayCountry}: ${entryRules.describe(c.entry)}`);
      console.log(`     ${c.entry.confidence} confidence, checked ${entryRules.checkedAt} — verify with the government`);
    }
    if (c.entryChange) console.log(`  ⚠ ${c.entryChange.text}`);

    console.log(`\n  → Confirm price and availability in ${c.leg1.carrier}'s multi-city search.`);
  }
}

console.log(`\n${'═'.repeat(74)}`);
console.log(`  ${res.apiCalls} API call(s) this search.`);
if (source.stats) {
  const s = source.stats();
  console.log(`  cache: ${s.hits} hit(s), ${s.misses} miss(es) — repeat searches are free.`);
}
console.log(`  Programme data checked ${PROGRAMS_CHECKED_AT}. Candidates, not quotes.\n`);
