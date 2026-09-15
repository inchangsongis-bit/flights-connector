import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTimestamp, normaliseFlight, parseDepartures, describeShape, createAeroDataBoxSource,
} from '../aerodatabox.mjs';

/**
 * Mirrors a real AeroDataBox departure-board record, confirmed 2026-09-15
 * against a 408-flight SEA board. Note `arrival` carries BOTH the airport and
 * the scheduled time — the destination is at arrival.airport.iata, and the
 * arrival instant the layover calculation depends on is at
 * arrival.scheduledTime.utc. No terminal field is provided.
 */
const SAMPLE = {
  departures: [
    {
      number: 'NH 177',
      airline: { name: 'All Nippon Airways', iata: 'NH' },
      departure: { scheduledTime: { utc: '2026-10-13 20:35Z', local: '2026-10-13 13:35-07:00' } },
      arrival: {
        airport: { iata: 'NRT', name: 'Tokyo Narita' },
        scheduledTime: { utc: '2026-10-14 07:25Z', local: '2026-10-14 16:25+09:00' },
      },
      aircraft: { model: 'Boeing 787-9' },
      isCargo: false,
    },
  ],
};

describe('parseTimestamp', () => {
  test('accepts the space-separated form AeroDataBox emits', () => {
    const d = parseTimestamp('2026-10-13 15:20+09:00');
    assert.ok(d instanceof Date);
    assert.equal(d.toISOString(), '2026-10-13T06:20:00.000Z');
  });

  test('accepts proper ISO too', () => {
    assert.equal(parseTimestamp('2026-10-13T06:20:00Z').toISOString(), '2026-10-13T06:20:00.000Z');
  });

  test('returns null rather than an Invalid Date', () => {
    // An Invalid Date propagates silently into arithmetic and produces NaN
    // layovers. Null fails at the point of use instead.
    assert.equal(parseTimestamp('not a date'), null);
    assert.equal(parseTimestamp(null), null);
    assert.equal(parseTimestamp(''), null);
  });
});

describe('normaliseFlight', () => {
  const f = normaliseFlight(SAMPLE.departures[0]);

  test('maps the fields the engine needs', () => {
    assert.equal(f.carrier, 'NH');
    assert.equal(f.flightNumber, 'NH 177');
    assert.equal(f.destination, 'NRT');
    // Confirmed absent from this endpoint across 408 real flights.
    assert.equal(f.departureTerminal, null);
  });

  test('produces real Date instants, not strings', () => {
    assert.ok(f.departureUtc instanceof Date);
    assert.ok(f.arrivalUtc instanceof Date);
    assert.equal((f.arrivalUtc - f.departureUtc) / 60000, 650, '10h50m block time');
  });

  test('the departure board carries arrival times — the whole overnight calc depends on it', () => {
    // Confirmed 397/408 on a real SEA board. Without leg-1 arrival there is
    // nothing to measure a layover from.
    assert.ok(f.arrivalUtc instanceof Date);
    assert.equal(typeof f.arrivalLocal, 'string');
  });

  test('keeps local strings for display only', () => {
    assert.equal(typeof f.departureLocal, 'string');
    assert.match(f.departureLocal, /-07:00$/);
  });

  test('records which candidate path resolved each field', () => {
    assert.equal(f._resolved.carrierIata, 'airline.iata');
    assert.equal(f._resolved.destinationIata, 'arrival.airport.iata');
    assert.equal(f._resolved.departureUtc, 'departure.scheduledTime.utc');
  });

  test('falls back through candidate paths when the primary is absent', () => {
    // The fallback list is why the adapter worked on its first real call: the
    // destination turned out to live at arrival.airport.iata, not the path
    // guessed first.
    const g = normaliseFlight({
      number: 'XX 1',
      airline: { icao: 'ANA' },
      movement: { airport: { iata: 'HND' }, scheduledTime: { utc: '2026-10-13 01:00Z' } },
    });
    assert.equal(g.carrier, 'ANA', 'falls back to icao');
    assert.equal(g.destination, 'HND', 'falls back to movement.airport.iata');
    assert.equal(g._resolved.departureUtc, 'movement.scheduledTime.utc');
  });

  test('an unmappable record yields nulls, never undefined arithmetic', () => {
    const g = normaliseFlight({ foo: 'bar' });
    assert.equal(g.carrier, null);
    assert.equal(g.departureUtc, null);
  });
});

describe('describeShape', () => {
  test('reports the winning path for each field', () => {
    const s = describeShape(parseDepartures(SAMPLE));
    assert.equal(s.ok, true);
    assert.equal(s.chosen.carrierIata, 'airline.iata');
    assert.equal(s.criticalMissing.length, 0);
    assert.equal(s.coverage.withDepartureUtc, 1);
  });

  test('flags the critical fields when the shape is wrong', () => {
    const s = describeShape(parseDepartures({ departures: [{ nope: true }] }));
    assert.equal(s.ok, false);
    assert.deepEqual(s.criticalMissing.sort(), ['carrierIata', 'departureUtc', 'destinationIata']);
  });

  test('a known-absent field is not reported as a surprise', () => {
    const s = describeShape(parseDepartures(SAMPLE));
    assert.ok(s.missing.includes('departureTerminal'), 'still recorded as missing');
    assert.ok(!s.unexpectedMissing.includes('departureTerminal'), 'but not flagged as unexpected');
  });

  test('handles an empty board without throwing', () => {
    assert.equal(describeShape(parseDepartures({ departures: [] })).ok, false);
  });
});

describe('createAeroDataBoxSource', () => {
  const okResponse = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

  test('requires a key', () => {
    assert.throws(() => createAeroDataBoxSource({}), /apiKey is required/);
  });

  test('builds the documented URL and sends both RapidAPI headers', async () => {
    let seen = null;
    const src = createAeroDataBoxSource({
      apiKey: 'k',
      fetchImpl: async (url, init) => { seen = { url, init }; return okResponse(SAMPLE); },
    });
    const flights = await src.getDepartures('SEA', '2026-10-13', { fromHour: 6, toHour: 18 });

    assert.match(seen.url, /airports\/iata\/SEA\/2026-10-13T06:00\/2026-10-13T18:00/);
    assert.match(seen.url, /direction=Departure/);
    assert.equal(seen.init.headers['x-rapidapi-key'], 'k');
    assert.equal(seen.init.headers['x-rapidapi-host'], 'aerodatabox.p.rapidapi.com');
    assert.equal(flights.length, 1);
    assert.equal(flights[0].carrier, 'NH');
  });

  test('pads single-digit hours', async () => {
    let seen = null;
    const src = createAeroDataBoxSource({
      apiKey: 'k',
      fetchImpl: async (url) => { seen = url; return okResponse({ departures: [] }); },
    });
    await src.getDepartures('SEA', '2026-10-13', { fromHour: 6, toHour: 9 });
    assert.match(seen, /T06:00\/2026-10-13T09:00/);
  });

  test('distinguishes a proxy 403 from a RapidAPI 403', async () => {
    const proxy = createAeroDataBoxSource({
      apiKey: 'k',
      fetchImpl: async () => ({ ok: false, status: 403, text: async () => '' }),
    });
    await assert.rejects(proxy.getDepartures('SEA', '2026-10-13'), /egress proxy is blocking/);

    const api = createAeroDataBoxSource({
      apiKey: 'k',
      fetchImpl: async () => ({ ok: false, status: 403, text: async () => '{"message":"not subscribed"}' }),
    });
    await assert.rejects(api.getDepartures('SEA', '2026-10-13'), /403 from AeroDataBox/);
  });

  test('names the quota when it runs out', async () => {
    const src = createAeroDataBoxSource({
      apiKey: 'k',
      fetchImpl: async () => ({ ok: false, status: 429, text: async () => '' }),
    });
    await assert.rejects(src.getDepartures('SEA', '2026-10-13'), /quota exhausted/);
  });

  test('reports non-JSON rather than throwing a parse error', async () => {
    const src = createAeroDataBoxSource({
      apiKey: 'k',
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>nope</html>' }),
    });
    await assert.rejects(src.getDepartures('SEA', '2026-10-13'), /returned non-JSON/);
  });
});
