#!/usr/bin/env node
/**
 * Builds web/ from the committed data and the real engine source.
 *
 *   node scripts/build-web.mjs      # or: npm run build:web
 *
 * Two jobs, and the second is the important one:
 *
 *  1. web/data.json — the reference data, trimmed to airports that actually
 *     connect things (>= MIN_DEGREE directional pairs), in the ENGINE'S OWN
 *     shape. Same field names Node uses, so one engine reads both.
 *
 *  2. web/engine/ — a copy of the pure engine modules. The page imports these
 *     rather than reimplementing them. Before this existed the browser carried
 *     a hand-written copy of the layover and gateway rules, which could drift
 *     from the Node version silently — and the Node tests only covered one of
 *     the two.
 */

import { writeFile, mkdir, copyFile } from 'node:fs/promises';
import { statSync } from 'node:fs';

import airportsData from '../data/airports.json' with { type: 'json' };
import routesData from '../data/routes.json' with { type: 'json' };
import carriersData from '../data/carriers.json' with { type: 'json' };
import programsData from '../data/stopover-programs.json' with { type: 'json' };
import entryData from '../data/entry-rules.json' with { type: 'json' };
import baggageData from '../data/baggage-rules.json' with { type: 'json' };

/** Airports appearing in fewer than this many routes cannot usefully be a gateway. */
const MIN_DEGREE = 8;

/** The pure modules the browser needs. data-node.mjs stays behind — it reads disk. */
const ENGINE_FILES = ['time.mjs', 'layover.mjs', 'network.mjs', 'entry.mjs', 'baggage.mjs', 'index.mjs'];

const kb = (p) => `${(statSync(p).size / 1024).toFixed(0)}KB`;

const degree = {};
for (const key of Object.keys(routesData.routes)) {
  const [a, b] = key.split('-');
  degree[a] = (degree[a] ?? 0) + 1;
  degree[b] = (degree[b] ?? 0) + 1;
}

const keep = new Set(
  Object.keys(airportsData.airports).filter((a) => (degree[a] ?? 0) >= MIN_DEGREE),
);

const airports = {};
for (const iata of [...keep].sort()) {
  const a = airportsData.airports[iata];
  airports[iata] = {
    iata,
    name: a.name,
    city: a.city,
    country: a.country,
    lat: Number(a.lat.toFixed(3)),
    lon: Number(a.lon.toFixed(3)),
    tz: a.tz,
    ...(a.metro ? { metro: a.metro } : {}),
  };
}

const routes = {};
for (const [key, carriers] of Object.entries(routesData.routes)) {
  const [a, b] = key.split('-');
  if (keep.has(a) && keep.has(b)) routes[key] = carriers;
}

await mkdir('web/engine', { recursive: true });

await writeFile('web/data.json', JSON.stringify({
  meta: {
    generatedAt: new Date().toISOString().slice(0, 10),
    routeGraphGeneratedAt: routesData._generated_at,
    routeSource: 'OpenFlights (~2014) — candidate pre-filter only',
    programsCheckedAt: programsData.checked_at,
    entryCheckedAt: entryData.checked_at,
    airportCount: Object.keys(airports).length,
    routeCount: Object.keys(routes).length,
    minDegree: MIN_DEGREE,
  },
  airports,
  routes,
  alliances: carriersData.alliances,
  programs: programsData.carriers,
  entry: entryData,
  baggage: baggageData,
}));

for (const f of ENGINE_FILES) await copyFile(`src/engine/${f}`, `web/engine/${f}`);

console.log(`web/data.json    ${kb('web/data.json')}  ${Object.keys(airports).length} airports, `
  + `${Object.keys(routes).length} routes, ${programsData.carriers.length} programmes`);
console.log(`web/engine/      ${ENGINE_FILES.join(', ')}`);
console.log(`  dropped ${Object.keys(airportsData.airports).length - keep.size} airports below degree ${MIN_DEGREE}`);
