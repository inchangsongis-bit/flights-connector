#!/usr/bin/env node
/**
 * Validates data/stopover-programs.json.
 *
 * The table is hand-edited and will drift, so the rules that matter most are the
 * honesty ones (requirements LC-4): every row cites a source, every source is
 * dated, and nothing is presented as certain when it isn't.
 *
 * Usage: node scripts/validate-data.mjs
 * Exits non-zero on error so it can gate CI later.
 */

import { readFileSync } from 'node:fs';

const PATH = new URL('../data/stopover-programs.json', import.meta.url);
const data = JSON.parse(readFileSync(PATH, 'utf8'));

const errors = [];
const warnings = [];

const TRISTATE = [true, false, 'unknown', 'unofficial'];
const CONFIDENCE = ['high', 'medium', 'low'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const seen = new Set();

for (const c of data.carriers) {
  const id = c.carrier_iata ?? '(missing iata)';
  const err = (m) => errors.push(`${id}: ${m}`);
  const warn = (m) => warnings.push(`${id}: ${m}`);

  if (!/^[A-Z0-9]{2}$/.test(c.carrier_iata ?? '')) err('carrier_iata must be a 2-character IATA code');
  if (seen.has(c.carrier_iata)) err('duplicate carrier_iata');
  seen.add(c.carrier_iata);

  if (!c.carrier_name) err('missing carrier_name');
  if (!Array.isArray(c.hub_airports) || !c.hub_airports.length) err('missing hub_airports');
  if (!/^[A-Z]{2}$/.test(c.hub_country ?? '')) err('hub_country must be an ISO-3166 alpha-2 code');

  // Honesty rules — these are the point of this validator.
  if (!Array.isArray(c.sources) || !c.sources.length) err('no sources — every row must cite (LC-4)');
  for (const s of c.sources ?? []) {
    if (!s.url?.startsWith('http')) err(`source has no usable url: ${JSON.stringify(s)}`);
    if (!ISO_DATE.test(s.checked_at ?? '')) err(`source missing/!ISO checked_at: ${s.url}`);
  }
  if (!CONFIDENCE.includes(c.confidence)) err(`confidence must be one of ${CONFIDENCE.join('/')}`);
  if (c.verify_before_display !== true) {
    err('verify_before_display must be true — no row in this table is a guarantee (FR-32)');
  }

  for (const key of ['fare_stopover', 'carrier_provided_hotel', 'paid_stopover_package', 'transit_tour']) {
    const block = c[key];
    if (!block) { warn(`missing block "${key}" — use {"available":"unknown"} rather than omitting`); continue; }
    if (!TRISTATE.includes(block.available)) {
      err(`${key}.available must be one of ${TRISTATE.map(String).join('/')}, got ${JSON.stringify(block.available)}`);
    }
  }

  // The Dubai Connect trap: a carrier-provided hotel that requires no shorter
  // connection to exist will normally NOT apply to a deliberately chosen long
  // layover. If we don't know, we must not imply that it does.
  const hotel = c.carrier_provided_hotel;
  if (hotel?.available === true && hotel.requires_no_shorter_connection === undefined) {
    err('carrier_provided_hotel is available but requires_no_shorter_connection is unset — '
      + 'this decides whether a chosen stopover qualifies at all');
  }
  if (hotel?.available === true && hotel.requires_no_shorter_connection === true && !hotel.notes) {
    warn('hotel requires no shorter connection but has no notes explaining the disqualification');
  }

  if (c.confidence === 'low' && !c.verify_before_display) warn('low confidence should never auto-display');
}

if (!ISO_DATE.test(data.checked_at ?? '')) errors.push('top-level checked_at missing or not ISO-8601');

const relevant = data.carriers.filter((c) => c.relevant_to_motivating_case).length;
const freeStopover = data.carriers.filter((c) => c.fare_stopover?.available === true).length;
const freeHotel = data.carriers.filter((c) => c.carrier_provided_hotel?.available === true).length;
const conditional = data.carriers.filter((c) => c.carrier_provided_hotel?.requires_no_shorter_connection === true).length;

console.log(`data/stopover-programs.json — ${data.carriers.length} carriers, checked ${data.checked_at}`);
console.log(`  ${relevant} relevant to the Seattle-Tokyo-Seoul case`);
console.log(`  ${freeStopover} with a published fare stopover`);
console.log(`  ${freeHotel} with a carrier-provided hotel (${conditional} confirmed conditional on no shorter connection)`);
console.log(`  confidence: ${CONFIDENCE.map((l) => `${data.carriers.filter((c) => c.confidence === l).length} ${l}`).join(', ')}`);

if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  ! ${w}`);
}
if (errors.length) {
  console.error(`\n${errors.length} error(s):`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log('\nOK');
