#!/usr/bin/env node
/**
 * Generates data/airports.json and data/routes.json from OpenFlights.
 *
 * Run only to refresh; the generated files are committed, so the app never
 * depends on this script or on network access at runtime.
 *
 *   node scripts/build-reference-data.mjs
 *
 * WHY OPENFLIGHTS, GIVEN IT IS STALE
 * ──────────────────────────────────
 * The route data is roughly 2014-era and carriers have changed since. That is
 * tolerable here and nowhere else, because the route graph is only ever a
 * *candidate pre-filter* (requirements §8.4): every candidate it proposes is
 * then confirmed against live schedules before the user sees it.
 *
 *   - false positive (route no longer flown) → dropped by the schedule check
 *   - false negative (route added since 2014) → a missed option, invisible
 *
 * Only the second is a real cost, and it buys us fan-out at zero API calls,
 * which is what makes a ~600 unit/month free tier viable at all. Airport
 * coordinates and IANA timezones age far better than routes do.
 *
 * OurAirports would be the better airport source (public domain, maintained)
 * but is unreachable from this environment, and it carries no timezone column
 * anyway — OpenFlights does, which is the field NFR-1 actually depends on.
 */

import { writeFile } from 'node:fs/promises';

const SOURCES = {
  airports: 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat',
  routes: 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/routes.dat',
  // Country NAME -> ISO 3166-1 alpha-2. Airport records carry only the name,
  // but entry rules are keyed by code, and a 205-row hand-maintained map is a
  // liability. OpenFlights publishes the mapping, so use it.
  countries: 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/countries.dat',
};

/** OpenFlights ships RFC4180-ish CSV with quoted fields and \N for null. */
function parseCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && quoted && line[i + 1] === '"') { cell += '"'; i += 1; }
    else if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { cells.push(cell); cell = ''; }
    else cell += ch;
  }
  cells.push(cell);
  return cells.map((c) => (c === '\\N' ? null : c));
}

async function fetchLines(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return (await res.text()).trim().split(/\r?\n/);
}

// IATA metropolitan groupings. Hand-maintained — small, and we need it exact.
// Arriving at one member and departing another is a different, much harder
// connection (requirements FR-17), never a plain layover.
const METRO = {
  TYO: ['HND', 'NRT'], OSA: ['KIX', 'ITM', 'UKB'], SEL: ['ICN', 'GMP'],
  NYC: ['JFK', 'LGA', 'EWR'], WAS: ['DCA', 'IAD', 'BWI'], CHI: ['ORD', 'MDW'],
  LON: ['LHR', 'LGW', 'STN', 'LTN', 'LCY'], PAR: ['CDG', 'ORY'],
  MIL: ['MXP', 'LIN', 'BGY'], MOW: ['SVO', 'DME', 'VKO'],
  SAO: ['GRU', 'CGH'], RIO: ['GIG', 'SDU'], BUE: ['EZE', 'AEP'],
  STO: ['ARN', 'BMA'], ROM: ['FCO', 'CIA'], BKK: ['BKK', 'DMK'],
  TPE: ['TPE', 'TSA'], SFO: ['SFO'], LAX: ['LAX'],
};
const metroOf = Object.fromEntries(
  Object.entries(METRO).flatMap(([metro, members]) => members.map((m) => [m, metro])),
);

async function main() {
  console.log('Fetching OpenFlights…');
  const [airportLines, routeLines, countryLines] = await Promise.all([
    fetchLines(SOURCES.airports),
    fetchLines(SOURCES.routes),
    fetchLines(SOURCES.countries),
  ]);

  // ── Country name -> ISO alpha-2 ─────────────────────────────────────────
  const countryCode = {};
  for (const line of countryLines) {
    const [name, iso] = parseCsvLine(line);
    if (name && iso && /^[A-Z]{2}$/.test(iso)) countryCode[name] = iso;
  }
  // OpenFlights' airport records use a few names its own country file does not.
  Object.assign(countryCode, {
    'South Korea': 'KR', 'North Korea': 'KP', 'Hong Kong': 'HK', Macau: 'MO',
    Taiwan: 'TW', Czechia: 'CZ', 'Burma': 'MM',
  });

  // ── Airports ────────────────────────────────────────────────────────────
  const airports = {};
  let noTz = 0;
  for (const line of airportLines) {
    const c = parseCsvLine(line);
    if (c.length < 13) continue;
    const [, name, city, country, iata, icao, lat, lon, , , , tz, type] = c;
    if (!iata || iata.length !== 3 || !/^[A-Z]{3}$/.test(iata)) continue;
    if (type !== 'airport') continue;
    if (!tz) { noTz += 1; continue; }   // NFR-1: an airport without a zone is useless to us
    airports[iata] = {
      iata,
      icao: icao || null,
      name,
      city,
      country,
      lat: Number(lat),
      lon: Number(lon),
      tz,
      ...(countryCode[country] ? { countryCode: countryCode[country] } : {}),
      ...(metroOf[iata] ? { metro: metroOf[iata] } : {}),
    };
  }

  // ── Routes ──────────────────────────────────────────────────────────────
  // Compact form: "SEA-NRT": ["NH","UA"]. Nonstop only (stops === "0"), both
  // endpoints known, 2-char carrier codes.
  const routes = {};
  let skipped = 0;
  for (const line of routeLines) {
    const c = parseCsvLine(line);
    if (c.length < 9) continue;
    // routes.dat: 0 airline, 1 airlineId, 2 src, 3 srcId, 4 dst, 5 dstId, 6 codeshare, 7 stops, 8 equipment
    const [carrier, , src, , dst, , , stops] = c;
    if (stops !== '0') { skipped += 1; continue; }
    if (!carrier || carrier.length !== 2) { skipped += 1; continue; }
    if (!airports[src] || !airports[dst] || src === dst) { skipped += 1; continue; }
    const key = `${src}-${dst}`;
    (routes[key] ??= new Set()).add(carrier);
  }
  const routesOut = Object.fromEntries(
    Object.entries(routes).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, [...v].sort()]),
  );

  const generated = new Date().toISOString().slice(0, 10);
  const header = {
    _source: 'OpenFlights (https://github.com/jpatokal/openflights), ODbL',
    _generated_by: 'scripts/build-reference-data.mjs',
    _generated_at: generated,
    _staleness_warning: 'Route data is approximately 2014-era. Usable ONLY as a candidate '
      + 'pre-filter; every candidate must be confirmed against live schedules before display.',
  };

  await writeFile('data/airports.json', `${JSON.stringify({ ...header, airports }, null, 2)}\n`);
  await writeFile('data/routes.json', `${JSON.stringify({ ...header, routes: routesOut }, null, 2)}\n`);

  const withCode = Object.values(airports).filter((a) => a.countryCode).length;
  console.log(`  airports.json  ${Object.keys(airports).length} airports (${noTz} dropped for missing timezone)`);
  console.log(`                 ${withCode} with an ISO country code`
    + `${withCode < Object.keys(airports).length ? `, ${Object.keys(airports).length - withCode} without` : ''}`);
  console.log(`  routes.json    ${Object.keys(routesOut).length} directional pairs (${skipped} rows skipped)`);
  console.log(`  metro groups   ${Object.keys(METRO).length}`);
}

main().catch((err) => { console.error(`FAILED: ${err.message}`); process.exit(1); });
