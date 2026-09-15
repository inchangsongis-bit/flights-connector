import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSearch, addDays, _scoreForTests } from '../search.mjs';
import { network, entryRules } from '../data-node.mjs';

/** A fake schedule source: no network, and it counts its own calls. */
function fakeSource(boards) {
  let calls = 0;
  return {
    calls: () => calls,
    async getDepartures(airport, date) {
      calls += 1;
      return (boards[`${airport}_${date}`] ?? []).map((f) => ({
        ...f,
        departureUtc: f.departureUtc ? new Date(f.departureUtc) : null,
        arrivalUtc: f.arrivalUtc ? new Date(f.arrivalUtc) : null,
      }));
    },
  };
}

const flight = (carrier, number, destination, dep, arr) => ({
  carrier, flightNumber: number, destination,
  departureUtc: dep, arrivalUtc: arr,
  departureLocal: null, arrivalLocal: null,
});

/** SEA → NRT on NH, overnight in Tokyo, NRT → ICN on NH next morning. */
const BOARDS = {
  'SEA_2026-10-13': [
    flight('NH', 'NH 177', 'NRT', '2026-10-13T20:35:00Z', '2026-10-14T07:25:00Z'),
    flight('DL', 'DL 9', 'ICN', '2026-10-13T18:00:00Z', '2026-10-14T05:00:00Z'),
  ],
  // Leg 1 lands 2026-10-14 Tokyo local (the date line eats a day), so the
  // next-morning departure sits on the FIFTEENTH's board, not the fourteenth's.
  'NRT_2026-10-15': [
    flight('NH', 'NH 867', 'ICN', '2026-10-15T00:00:00Z', '2026-10-15T02:35:00Z'),
    flight('NH', 'NH 999', 'BKK', '2026-10-15T01:00:00Z', '2026-10-15T07:00:00Z'),
  ],
};

test('addDays crosses month and year ends', () => {
  assert.equal(addDays('2026-10-13', 1), '2026-10-14');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

describe('findOvernightCandidates', () => {
  test('finds the Seattle → Tokyo → Seoul overnight', async () => {
    const source = fakeSource(BOARDS);
    const search = createSearch({ source, network, entryRules });
    const { candidates } = await search.findOvernightCandidates('SEA', 'ICN', '2026-10-13');

    const tokyo = candidates.find((c) => c.gateway === 'NRT');
    assert.ok(tokyo, 'expected an NRT candidate');
    assert.equal(tokyo.leg1.flightNumber, 'NH 177');
    assert.equal(tokyo.leg2.flightNumber, 'NH 867');
    assert.equal(tokyo.layover.minutes, 16 * 60 + 35);
    assert.equal(tokyo.layover.isOvernight, true);
    assert.equal(tokyo.ticketability.status, 'same');
  });

  test('THE POINT OF THE ORDERING: the route graph filters before any API call', async () => {
    // One call for the origin board, then one per gateway actually reached —
    // not one per gateway the graph proposed, and nothing at all when the graph
    // rules the route out. Reversing this spends a month of quota per search.
    const source = fakeSource(BOARDS);
    const search = createSearch({ source, network, entryRules });
    const res = await search.findOvernightCandidates('SEA', 'ICN', '2026-10-13', { maxGateways: 4 });
    // The assertion is the RELATIONSHIP, not a magic number: calls scale with
    // gateways actually reached, never with the gateways the graph proposed.
    assert.equal(source.calls(), res.apiCalls, 'reported call count must match reality');
    const reached = new Set(res.candidates.map((c) => c.gateway)).size;
    assert.ok(source.calls() <= 2 + reached * 4,
      `calls (${source.calls()}) must scale with gateways reached (${reached}), not proposed (${res.gateways.length})`);
  });

  test('a route with no gateway costs zero API calls', async () => {
    const source = fakeSource({});
    const search = createSearch({ source, network });
    const res = await search.findOvernightCandidates('SEA', 'SEA', '2026-10-13');
    assert.equal(res.candidates.length, 0);
    assert.equal(res.apiCalls, 0);
    assert.equal(source.calls(), 0, 'must not call the API when the graph already says no');
  });

  test('nonstops are ignored — this tool is about the stop', async () => {
    const source = fakeSource(BOARDS);
    const search = createSearch({ source, network, entryRules });
    const { candidates } = await search.findOvernightCandidates('SEA', 'ICN', '2026-10-13');
    assert.ok(!candidates.some((c) => c.leg1.flightNumber === 'DL 9'));
  });

  test('onward flights to the wrong place are ignored', async () => {
    const source = fakeSource(BOARDS);
    const search = createSearch({ source, network, entryRules });
    const { candidates } = await search.findOvernightCandidates('SEA', 'ICN', '2026-10-13');
    assert.ok(!candidates.some((c) => c.leg2.flightNumber === 'NH 999'));
  });

  test('layovers outside the band are excluded', async () => {
    const source = fakeSource(BOARDS);
    const search = createSearch({ source, network, entryRules });
    const tight = await source.getDepartures('SEA', '2026-10-13');
    assert.ok(tight.length, 'sanity');

    const { candidates } = await search.findOvernightCandidates('SEA', 'ICN', '2026-10-13',
      { minLayoverHours: 20, maxLayoverHours: 36 });
    assert.equal(candidates.length, 0, '16h35m must fall outside a 20h floor');
  });

  test('attaches the stopover programme and entry rules', async () => {
    const source = fakeSource(BOARDS);
    const search = createSearch({ source, network, entryRules });
    const { candidates } = await search.findOvernightCandidates('SEA', 'ICN', '2026-10-13');
    const tokyo = candidates.find((c) => c.gateway === 'NRT');

    // 16h35m is under the 24h line, so ANA's programme must NOT be claimed.
    assert.ok(tokyo.program.highlights.some((h) => h.kind === 'below_stopover_threshold'));
    assert.ok(!tokyo.program.highlights.some((h) => h.kind === 'free_stopover'));

    assert.equal(tokyo.entry.status, 'visa_free');
    assert.equal(tokyo.entry.countryCode, 'JP');
  });

  test('entry is evaluated against the layover date, not today', async () => {
    const source = fakeSource({
      'SEA_2026-12-29': [flight('NH', 'NH 177', 'NRT', '2026-12-29T20:35:00Z', '2026-12-30T07:25:00Z')],
      'NRT_2026-12-31': [flight('NH', 'NH 867', 'ICN', '2026-12-31T00:00:00Z', '2026-12-31T02:35:00Z')],
    });
    const search = createSearch({ source, network, entryRules });
    const { candidates } = await search.findOvernightCandidates('SEA', 'ICN', '2026-12-29');
    const tokyo = candidates.find((c) => c.gateway === 'NRT');
    assert.equal(tokyo.entry.status, 'visa_free');
    // Korea's K-ETA waiver lapses two days later — but the LAYOVER is in Japan,
    // so it is Japan's rules that apply, not the destination's.
    assert.equal(tokyo.entry.countryCode, 'JP');
  });

  test('flights with no arrival time cannot form a layover and are dropped', async () => {
    const source = fakeSource({
      'SEA_2026-10-13': [flight('NH', 'NH 177', 'NRT', '2026-10-13T20:35:00Z', null)],
      'NRT_2026-10-15': [flight('NH', 'NH 867', 'ICN', '2026-10-15T00:00:00Z', '2026-10-15T02:35:00Z')],
    });
    const search = createSearch({ source, network, entryRules });
    const { candidates, reason } = await search.findOvernightCandidates('SEA', 'ICN', '2026-10-13');
    assert.equal(candidates.length, 0);
    assert.equal(reason, 'no-outbound-flights');
  });

  test('reports why it found nothing, rather than just nothing', async () => {
    const source = fakeSource({ 'SEA_2026-10-13': [], 'NRT_2026-10-15': [] });
    const search = createSearch({ source, network, entryRules });
    const res = await search.findOvernightCandidates('SEA', 'ICN', '2026-10-13');
    assert.equal(res.reason, 'no-outbound-flights');
    assert.ok(res.gateways.length, 'the gateways it tried are still reported');
  });
});

describe('ranking', () => {
  const base = {
    ticketability: { status: 'same' },
    usableCityHours: 6,
    detourRatio: 1.0,
    program: null,
  };

  test('REGRESSION: the detour term uses excess over a nonstop, not the raw ratio', () => {
    // `c.detourRatio ?? 1.5 - 1` parses as `c.detourRatio ?? (1.5 - 1)`, because
    // ?? binds looser than -. Every candidate therefore carried a ~20-point
    // penalty proportional to its raw ratio. A direct routing must score 0 here.
    const direct = _scoreForTests({ ...base, detourRatio: 1.0 });
    const slight = _scoreForTests({ ...base, detourRatio: 1.06 });
    assert.equal(slight - direct, 1.2000000000000028, 'a 6% detour costs 1.2 points, not 21.2');
    assert.ok(Math.abs(direct - -24) < 0.001, `direct routing should carry no detour penalty, got ${direct}`);
  });

  test('a big detour is penalised proportionally', () => {
    const near = _scoreForTests({ ...base, detourRatio: 1.06 });
    const far = _scoreForTests({ ...base, detourRatio: 1.45 });
    assert.ok(far > near);
    assert.ok(Math.abs((far - near) - 7.8) < 0.01);
  });

  test('ticketability dominates everything else', () => {
    const unticketable = _scoreForTests({ ...base, ticketability: { status: 'unknown' }, usableCityHours: 12 });
    const ticketable = _scoreForTests({ ...base, usableCityHours: 0, detourRatio: 1.45 });
    assert.ok(ticketable < unticketable, 'a poor routing you can book beats a great one you cannot');
  });

  test('a free stopover programme outweighs a moderate detour', () => {
    const withProgramme = _scoreForTests({
      ...base, detourRatio: 1.34, program: { highlights: [{ kind: 'free_stopover' }] },
    });
    const without = _scoreForTests({ ...base, detourRatio: 1.06 });
    assert.ok(withProgramme < without, 'a free stopover is worth more than 28% of extra distance');
  });

  test('the below-threshold note is not mistaken for a benefit', () => {
    const below = _scoreForTests({
      ...base, program: { highlights: [{ kind: 'below_stopover_threshold' }] },
    });
    assert.equal(below, _scoreForTests(base), 'explaining why a programme does NOT apply earns no bonus');
  });
});

describe('entry rules are never silently skipped', () => {
  test('an overnight in a country with no rules still reports unknown', async () => {
    // A live search through Vancouver and Beijing printed no entry advice at
    // all, because the country-name map in this file lacked them. Silence reads
    // as "fine". It must read as "not checked".
    const source = fakeSource({
      'SEA_2026-10-13': [flight('AC', 'AC 8803', 'YVR', '2026-10-13T17:50:00Z', '2026-10-13T19:00:00Z')],
      'YVR_2026-10-14': [flight('AC', 'AC 63', 'ICN', '2026-10-14T19:20:00Z', '2026-10-15T07:05:00Z')],
    });
    const search = createSearch({ source, network, entryRules });
    const { candidates } = await search.findOvernightCandidates('SEA', 'ICN', '2026-10-13',
      { minLayoverHours: 8, maxLayoverHours: 36 });

    const yvr = candidates.find((c) => c.gateway === 'YVR');
    assert.ok(yvr, 'expected the Vancouver candidate');
    assert.ok(yvr.entry, 'entry must be evaluated, not skipped');
    assert.equal(yvr.entry.status, 'unknown');
    assert.equal(yvr.entry.verifyBeforeTravel, true);
  });

  test('the country code comes from the airport record, not a hand-map', () => {
    assert.equal(network.airport('YVR').countryCode, 'CA');
    assert.equal(network.airport('PEK').countryCode, 'CN');
    assert.equal(network.airport('NRT').countryCode, 'JP');
  });
});

describe('day coverage', () => {
  test('an EVENING departure is found — the old 06:00-18:00 window missed these', () => {
    // Seattle's long-haul flights to Asia largely leave in the afternoon and
    // evening. A 20:15 departure was structurally invisible to the tool that
    // exists to find exactly this routing.
    const boards = {
      'SEA_2026-10-13|12-24': [flight('NH', 'NH 177', 'NRT', '2026-10-13T20:15:00Z', '2026-10-14T07:25:00Z')],
      'NRT_2026-10-15|0-12': [flight('NH', 'NH 867', 'ICN', '2026-10-15T00:00:00Z', '2026-10-15T02:35:00Z')],
    };
    const source = {
      calls: 0,
      async getDepartures(airport, date, { fromHour, toHour }) {
        this.calls += 1;
        return (boards[`${airport}_${date}|${fromHour}-${toHour}`] ?? []).map((f) => ({
          ...f,
          departureUtc: f.departureUtc ? new Date(f.departureUtc) : null,
          arrivalUtc: f.arrivalUtc ? new Date(f.arrivalUtc) : null,
        }));
      },
    };
    const search = createSearch({ source, network, entryRules });
    return search.findOvernightCandidates('SEA', 'ICN', '2026-10-13').then(({ candidates }) => {
      assert.ok(candidates.some((c) => c.leg1.flightNumber === 'NH 177'),
        'the evening departure must be found');
    });
  });

  test('a boundary flight returned by two windows is not counted twice', async () => {
    const dupe = flight('NH', 'NH 177', 'NRT', '2026-10-13T12:00:00Z', '2026-10-13T23:00:00Z');
    const source = {
      async getDepartures() {
        return [dupe].map((f) => ({
          ...f,
          departureUtc: new Date(f.departureUtc),
          arrivalUtc: new Date(f.arrivalUtc),
        }));
      },
    };
    const search = createSearch({ source, network, entryRules });
    const { candidates } = await search.findOvernightCandidates('SEA', 'ICN', '2026-10-13');
    // Same flight from both windows on leg 1 must not produce duplicate pairings.
    const leg1s = candidates.filter((c) => c.leg1.flightNumber === 'NH 177');
    assert.ok(leg1s.length <= 1, `expected no duplicate leg 1, got ${leg1s.length}`);
  });

  test('narrowing the windows trades coverage for quota, and says so in apiCalls', async () => {
    const source = { async getDepartures() { return []; } };
    const search = createSearch({ source, network, entryRules });
    const full = await search.findOvernightCandidates('SEA', 'ICN', '2026-10-13');
    const narrow = await search.findOvernightCandidates('SEA', 'ICN', '2026-10-13',
      { windows: [[6, 18]] });
    assert.equal(full.apiCalls, 2, 'a full day is two calls for the origin board');
    assert.equal(narrow.apiCalls, 1, 'one window is one call');
    assert.ok(narrow.apiCalls < full.apiCalls, 'narrowing trades coverage for quota');
  });
});

describe('the date line', () => {
  test('REGRESSION: onward boards follow the gateway local arrival date', async () => {
    // SEA→NRT departs the 13th in Seattle and lands the 14th in Tokyo, so the
    // next-morning departure is on the FIFTEENTH's board. Deriving board dates
    // from the origin's departure date fetched the 13th and 14th and found
    // nothing — silently, and only for routes that cross the date line, which
    // is every routing through Asia.
    const asked = [];
    const source = {
      async getDepartures(airport, date) {
        asked.push(`${airport}_${date}`);
        const boards = {
          'SEA_2026-10-13': [flight('NH', 'NH 177', 'NRT', '2026-10-13T20:35:00Z', '2026-10-14T07:25:00Z')],
          'NRT_2026-10-15': [flight('NH', 'NH 867', 'ICN', '2026-10-15T00:00:00Z', '2026-10-15T02:35:00Z')],
        };
        return (boards[`${airport}_${date}`] ?? []).map((f) => ({
          ...f,
          departureUtc: new Date(f.departureUtc),
          arrivalUtc: f.arrivalUtc ? new Date(f.arrivalUtc) : null,
        }));
      },
    };
    const search = createSearch({ source, network, entryRules });
    const { candidates } = await search.findOvernightCandidates('SEA', 'ICN', '2026-10-13');

    assert.ok(asked.some((a) => a === 'NRT_2026-10-15'),
      `must request the arrival-date board; asked for ${[...new Set(asked)].join(', ')}`);
    assert.ok(!asked.includes('NRT_2026-10-13'), 'must not request the departure-date board');
    assert.equal(candidates.length, 1, 'the Tokyo overnight must be found');
    assert.equal(candidates[0].layover.minutes, 16 * 60 + 35);
  });
});

describe('API budget', () => {
  const lateArrival = {
    'SEA_2026-10-13': [flight('NH', 'NH 177', 'NRT', '2026-10-13T20:35:00Z', '2026-10-14T07:25:00Z')],
  };

  test('boards that cannot hold a qualifying flight are not fetched', async () => {
    // Landing 16:25 Tokyo with an 8h minimum, nothing before 00:25 the next day
    // can qualify — so the whole arrival-day board, two calls, was waste.
    const asked = [];
    const source = {
      async getDepartures(airport, date, { fromHour, toHour }) {
        asked.push(`${airport} ${date} ${fromHour}-${toHour}`);
        return (lateArrival[`${airport}_${date}`] ?? []).map((f) => ({
          ...f, departureUtc: new Date(f.departureUtc), arrivalUtc: new Date(f.arrivalUtc),
        }));
      },
    };
    const search = createSearch({ source, network, entryRules });
    await search.findOvernightCandidates('SEA', 'ICN', '2026-10-13',
      { maxGateways: 1, maxApiCalls: 99 });

    assert.ok(!asked.some((a) => a.startsWith('NRT 2026-10-14')),
      `the arrival-day board cannot qualify and must not be fetched; asked: ${asked.join(' | ')}`);
    assert.ok(asked.some((a) => a.startsWith('NRT 2026-10-15')), 'the next day must be fetched');
  });

  test('a narrower layover band costs fewer calls', async () => {
    const count = async (opts) => {
      let n = 0;
      const source = {
        async getDepartures(airport, date) {
          n += 1;
          return (lateArrival[`${airport}_${date}`] ?? []).map((f) => ({
            ...f, departureUtc: new Date(f.departureUtc), arrivalUtc: new Date(f.arrivalUtc),
          }));
        },
      };
      const search = createSearch({ source, network, entryRules });
      await search.findOvernightCandidates('SEA', 'ICN', '2026-10-13',
        { maxGateways: 1, maxApiCalls: 99, ...opts });
      return n;
    };
    const wide = await count({ minLayoverHours: 8, maxLayoverHours: 36 });
    const narrow = await count({ minLayoverHours: 10, maxLayoverHours: 20 });
    assert.ok(narrow < wide, `narrow (${narrow}) should cost less than wide (${wide})`);
  });

  test('the guard stops before the expensive half, not after it', async () => {
    let n = 0;
    const source = {
      async getDepartures(airport, date) {
        n += 1;
        return (lateArrival[`${airport}_${date}`] ?? []).map((f) => ({
          ...f, departureUtc: new Date(f.departureUtc), arrivalUtc: new Date(f.arrivalUtc),
        }));
      },
    };
    const search = createSearch({ source, network, entryRules });
    const res = await search.findOvernightCandidates('SEA', 'ICN', '2026-10-13',
      { maxGateways: 3, maxApiCalls: 3 });

    assert.equal(res.reason, 'over-budget');
    assert.equal(n, 2, 'only the origin board is spent before stopping');
    assert.ok(res.budget.estimate > res.budget.limit);
    assert.equal(res.budget.spentSoFar, 2);
  });

  test('a dry run reports the plan and spends nothing beyond the origin board', async () => {
    let n = 0;
    const source = {
      async getDepartures(airport, date) {
        n += 1;
        return (lateArrival[`${airport}_${date}`] ?? []).map((f) => ({
          ...f, departureUtc: new Date(f.departureUtc), arrivalUtc: new Date(f.arrivalUtc),
        }));
      },
    };
    const search = createSearch({ source, network, entryRules });
    const res = await search.findOvernightCandidates('SEA', 'ICN', '2026-10-13',
      { maxGateways: 1, maxApiCalls: 99, dryRun: true });

    assert.equal(res.reason, 'dry-run');
    assert.equal(n, 2, 'nothing beyond the origin board');
    assert.ok(res.plan[0].boards.length > 0, 'the plan names the boards it would fetch');
  });
});
