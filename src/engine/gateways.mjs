/**
 * Candidate gateway discovery from the offline route graph — requirements §8.4.
 *
 * This is the step that makes a ~600 unit/month schedule tier viable: it narrows
 * ~40 possible connection points to a handful using zero API calls, so the
 * metered source is only ever queried for a shortlist.
 *
 * The route graph is stale (see scripts/build-reference-data.mjs). That is
 * acceptable here and only here, because every candidate is confirmed against
 * live schedules before display. A route that no longer exists is dropped by
 * that check; a route added since is simply never suggested.
 */

import routesData from '../../data/routes.json' with { type: 'json' };
import airportsData from '../../data/airports.json' with { type: 'json' };
import { ticketability } from './ticketability.mjs';
import { programsAtAirport } from './stopover.mjs';

const routes = routesData.routes;
const airports = airportsData.airports;

export const AIRPORTS = airports;
export const ROUTE_GRAPH_GENERATED_AT = routesData._generated_at;

export const airport = (iata) => airports[iata] ?? null;

/** Airports in the same IATA metropolitan group, including the one given. */
export function metroSiblings(iata) {
  const a = airports[iata];
  if (!a?.metro) return [iata];
  return Object.keys(airports).filter((k) => airports[k].metro === a.metro);
}

/** Expand a search input that may be an airport or a metro code. */
export function expandToAirports(code) {
  const direct = airports[code];
  if (direct) return metroSiblings(code);
  const members = Object.keys(airports).filter((k) => airports[k].metro === code);
  return members.length ? members : [];
}

const carriersOn = (from, to) => routes[`${from}-${to}`] ?? [];

const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in km. */
export function distanceKm(a, b) {
  const A = airports[a];
  const B = airports[b];
  if (!A || !B) return null;
  const dLat = toRad(B.lat - A.lat);
  const dLon = toRad(B.lon - A.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(A.lat)) * Math.cos(toRad(B.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/**
 * How far out of the way a gateway takes you: (O→C + C→D) / O→D.
 *
 * 1.0 is directly en route. Without this, the route graph cheerfully proposes
 * Seattle → Dubai → Seoul (ratio ~2.3) alongside Seattle → Tokyo → Seoul
 * (~1.09), because both are "two flights that exist". Flying the wrong way
 * around the planet is not a stopover, it is a different trip.
 */
export function detourRatio(origin, via, destination) {
  const direct = distanceKm(origin, destination);
  const legs = distanceKm(origin, via) + distanceKm(via, destination);
  if (!direct || !legs) return null;
  return legs / direct;
}

/**
 * Find every C such that origin → C and C → destination are both flown.
 *
 * Returns candidates ranked by ticketability confidence, then by whether a
 * stopover programme exists at that gateway — a free stopover is worth more to
 * the user than a marginally better routing.
 */
export function findGateways(origin, destination, opts = {}) {
  const { excludeMetros = [], onlySameCarrier = false, limit = 20, maxDetour = 1.5 } = opts;

  const origins = expandToAirports(origin);
  const destinations = expandToAirports(destination);
  if (!origins.length || !destinations.length) return [];

  const originMetros = new Set(origins.map((a) => airports[a]?.metro ?? a));
  const destMetros = new Set(destinations.map((a) => airports[a]?.metro ?? a));

  const candidates = new Map();

  for (const from of origins) {
    for (const key of Object.keys(routes)) {
      if (!key.startsWith(`${from}-`)) continue;
      const via = key.slice(from.length + 1);
      const viaMetro = airports[via]?.metro ?? via;

      // A "connection" in the origin or destination city is not a connection.
      if (originMetros.has(viaMetro) || destMetros.has(viaMetro)) continue;
      if (excludeMetros.includes(viaMetro)) continue;

      const inbound = carriersOn(from, via);
      for (const to of destinations) {
        const onward = carriersOn(via, to);
        if (!onward.length) continue;

        const detour = detourRatio(from, via, to);
        if (detour != null && detour > maxDetour) continue;

        const sameCarrier = inbound.filter((c) => onward.includes(c));
        if (onlySameCarrier && !sameCarrier.length) continue;

        const best = sameCarrier.length
          ? ticketability(sameCarrier[0], sameCarrier[0])
          : bestCrossCarrier(inbound, onward);
        if (best.status === 'unknown' && onlySameCarrier) continue;

        // Dedupe per (origin, gateway, destination METRO): arriving ICN vs GMP
        // is a real difference, but listing the same gateway twice is noise.
        // Keep whichever variant ranks better.
        const destMetro = airports[to]?.metro ?? to;
        const id = `${from}-${via}-${destMetro}`;
        const candidate = {
          origin: from,
          via,
          destination: to,
          viaMetro,
          viaCity: airports[via]?.city ?? via,
          viaCountry: airports[via]?.country ?? null,
          viaTz: airports[via]?.tz ?? null,
          detourRatio: detour,
          inboundCarriers: inbound,
          onwardCarriers: onward,
          sameCarrier,
          ticketability: best,
          stopoverPrograms: programsAtAirport(via)
            .filter((p) => sameCarrier.includes(p.carrier_iata) || inbound.includes(p.carrier_iata))
            .map((p) => p.carrier_iata),
        };

        const existing = candidates.get(id);
        if (existing && rank(existing) <= rank(candidate)) continue;
        candidates.set(id, candidate);
      }
    }
  }

  return [...candidates.values()].sort((a, b) => rank(a) - rank(b)).slice(0, limit);
}

function bestCrossCarrier(inbound, onward) {
  let best = { status: 'unknown', confidence: 'low', note: 'No known link between carriers.' };
  for (const a of inbound) {
    for (const b of onward) {
      const t = ticketability(a, b);
      if (t.status === 'alliance') return t;
      if (t.status !== 'unknown') best = t;
    }
  }
  return best;
}

const STATUS_RANK = { same: 0, alliance: 1, unknown: 2 };

/**
 * Lower is better. Ticketability dominates (an unticketable routing is not the
 * product), then a stopover programme, then how far out of the way it is.
 */
function rank(c) {
  const base = STATUS_RANK[c.ticketability.status] * 100;
  const programBonus = c.stopoverPrograms?.length ? -30 : 0;
  const detourPenalty = c.detourRatio != null ? (c.detourRatio - 1) * 40 : 20;
  return base + programBonus + detourPenalty;
}
