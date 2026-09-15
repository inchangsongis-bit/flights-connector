/**
 * AeroDataBox schedule adapter.
 *
 * Turns an airport departure board into the normalised shape the engine wants.
 *
 * WHY THIS IS DEFENSIVE
 * ─────────────────────
 * AeroDataBox's docs are unreachable from the environment this was written in,
 * so the exact field paths are inferred rather than read. The probe proved the
 * envelope is right (`body.departures` held 443 flights for SEA) but never
 * looked inside a record, so the per-field mapping is still unverified.
 *
 * Rather than guess once and fail silently on undefined, every field is resolved
 * through a list of candidate paths, and `describeShape()` reports which path
 * actually matched — so one real call settles the mapping instead of a guessing
 * loop. Once the shape is confirmed, the candidate lists can collapse to one
 * entry each; until then, breadth is cheap and silence is expensive.
 */

/** Read the first candidate path that yields a non-null value. */
function pick(obj, paths) {
  for (const path of paths) {
    let v = obj;
    for (const key of path.split('.')) {
      if (v == null) break;
      v = v[key];
    }
    if (v != null && v !== '') return { value: v, path };
  }
  return { value: null, path: null };
}

/** Candidate paths per field, most likely first. */
const FIELDS = {
  flightNumber: ['number', 'flight.number', 'callSign'],
  carrierIata: ['airline.iata', 'airline.icao', 'airline.name'],
  carrierName: ['airline.name'],
  destinationIata: ['movement.airport.iata', 'arrival.airport.iata', 'movement.airport.iataCode'],
  destinationName: ['movement.airport.name', 'arrival.airport.name'],
  departureUtc: ['departure.scheduledTime.utc', 'movement.scheduledTime.utc', 'scheduledTime.utc'],
  departureLocal: ['departure.scheduledTime.local', 'movement.scheduledTime.local', 'scheduledTime.local'],
  arrivalUtc: ['arrival.scheduledTime.utc', 'movement.revisedTime.utc'],
  arrivalLocal: ['arrival.scheduledTime.local'],
  departureTerminal: ['departure.terminal', 'movement.terminal'],
  aircraft: ['aircraft.model'],
  isCargo: ['isCargo'],
};

/**
 * AeroDataBox renders instants as "2026-10-13 15:20+09:00" — a space where
 * ISO-8601 wants a T. Date.parse tolerates that unevenly across engines, so
 * normalise before constructing. Returns null rather than an Invalid Date, so a
 * bad value fails loudly at the point of use instead of poisoning arithmetic.
 */
export function parseTimestamp(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** One departure-board row → the engine's segment shape. */
export function normaliseFlight(raw) {
  const f = {};
  const resolved = {};
  for (const [name, paths] of Object.entries(FIELDS)) {
    const { value, path } = pick(raw, paths);
    f[name] = value;
    resolved[name] = path;
  }
  return {
    carrier: f.carrierIata,
    carrierName: f.carrierName,
    flightNumber: f.flightNumber,
    destination: f.destinationIata,
    destinationName: f.destinationName,
    // UTC is what the engine computes with; local is for display only (NFR-1).
    departureUtc: parseTimestamp(f.departureUtc),
    departureLocal: f.departureLocal ?? null,
    arrivalUtc: parseTimestamp(f.arrivalUtc),
    arrivalLocal: f.arrivalLocal ?? null,
    departureTerminal: f.departureTerminal ?? null,
    aircraft: f.aircraft ?? null,
    isCargo: f.isCargo === true,
    _resolved: resolved,
  };
}

export function parseDepartures(body) {
  const rows = body?.departures ?? body?.arrivals ?? [];
  return rows.map(normaliseFlight);
}

/**
 * Which candidate path won for each field, and which fields found nothing.
 * Run this once against a real response and the mapping is settled.
 */
export function describeShape(flights) {
  const sample = flights.find((f) => f._resolved) ?? null;
  if (!sample) return { ok: false, reason: 'no flights to inspect' };

  const chosen = {};
  const missing = [];
  for (const [field, path] of Object.entries(sample._resolved)) {
    if (path) chosen[field] = path;
    else missing.push(field);
  }

  // Fields without which the engine cannot do its job at all.
  const CRITICAL = ['carrierIata', 'destinationIata', 'departureUtc'];
  const criticalMissing = CRITICAL.filter((f) => missing.includes(f));

  return {
    ok: criticalMissing.length === 0,
    chosen,
    missing,
    criticalMissing,
    coverage: {
      withCarrier: flights.filter((f) => f.carrier).length,
      withDestination: flights.filter((f) => f.destination).length,
      withDepartureUtc: flights.filter((f) => f.departureUtc).length,
      withArrivalUtc: flights.filter((f) => f.arrivalUtc).length,
      total: flights.length,
    },
  };
}

const HOST = 'aerodatabox.p.rapidapi.com';

/**
 * @param {object} opts
 * @param {string} opts.apiKey                RapidAPI key
 * @param {Function} [opts.fetchImpl]         injectable for tests
 * @returns {{getDepartures: Function}}
 */
export function createAeroDataBoxSource({ apiKey, fetchImpl = fetch }) {
  if (!apiKey) throw new Error('createAeroDataBoxSource: apiKey is required');

  /**
   * Departures from one airport within a local time window.
   * AeroDataBox caps the window at 12 hours, so a full day costs two calls —
   * which is why the route graph does the gateway fan-out offline first.
   */
  async function getDepartures(airport, date, { fromHour = 6, toHour = 18 } = {}) {
    const pad = (n) => String(n).padStart(2, '0');
    const url = `https://${HOST}/flights/airports/iata/${airport}`
      + `/${date}T${pad(fromHour)}:00/${date}T${pad(toHour)}:00`
      + '?direction=Departure&withLeg=true&withCancelled=false&withCodeshared=false'
      + '&withCargo=false&withPrivate=false&withLocation=false';

    const res = await fetchImpl(url, {
      headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': HOST },
    });
    const body = await res.text();

    if (res.status === 429) throw new Error('429 — AeroDataBox quota exhausted for this period.');
    if (res.status === 403 && !/message|subscribe/i.test(body)) {
      throw new Error(`403 with no RapidAPI body — an egress proxy is blocking ${HOST}, not a key problem.`);
    }
    if (!res.ok) throw new Error(`${res.status} from AeroDataBox: ${body.slice(0, 200)}`);

    let json;
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error(`AeroDataBox returned non-JSON: ${body.slice(0, 200)}`);
    }
    return parseDepartures(json);
  }

  return { getDepartures };
}
