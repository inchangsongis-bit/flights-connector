import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { network } from '../data-node.mjs';
import { classifyLayover } from '../layover.mjs';

// One engine, injected with the real committed data. The browser builds the
// same network from web/data.json, so these tests specify both.
const { ticketability, matchStopoverProgram } = network;

const jst = (s) => new Date(`${s}:00+09:00`);
const overnightTokyo = classifyLayover(jst('2026-09-21T16:20'), jst('2026-09-22T09:00'), 'Asia/Tokyo');

describe('ticketability', () => {
  test('same carrier is the high-confidence case', () => {
    const t = ticketability('NH', 'NH');
    assert.equal(t.status, 'same');
    assert.equal(t.confidence, 'high');
  });

  test('same alliance is plausible but not asserted', () => {
    const t = ticketability('NH', 'OZ'); // both Star
    assert.equal(t.status, 'alliance');
    assert.equal(t.confidence, 'medium');
    assert.match(t.note, /not guaranteed/i);
  });

  test('unrelated carriers warn that this may become a self-transfer', () => {
    const t = ticketability('NH', 'KE'); // Star vs SkyTeam
    assert.equal(t.status, 'unknown');
    assert.equal(t.confidence, 'low');
    assert.match(t.note, /self-transfer/i);
  });

  test('a missing carrier never silently passes', () => {
    assert.equal(ticketability('NH', null).status, 'unknown');
    assert.equal(ticketability(undefined, undefined).status, 'unknown');
  });
});

describe('matchStopoverProgram', () => {
  test('ANA at Tokyo surfaces the free first stopover — above 24h', () => {
    // Updated 2026-09-14: this originally used a 16h layover and asserted the
    // programme applied. It does not. A stopover is >24h by ANA's own
    // definition, so the fixture now spans two nights.
    const twoNights = classifyLayover(jst('2026-09-21T16:20'), jst('2026-09-23T09:00'), 'Asia/Tokyo');
    const m = matchStopoverProgram('NH', 'HND', twoNights);
    assert.ok(m, 'expected a match for ANA at Haneda');
    const free = m.highlights.find((h) => h.kind === 'free_stopover');
    assert.ok(free, 'expected a free_stopover highlight');
    assert.match(free.text, /first stopover free/i);
    assert.match(free.text, /130/);
  });

  test('carries provenance so the UI can cite and date it', () => {
    const m = matchStopoverProgram('JL', 'NRT',
      classifyLayover(jst('2026-09-21T16:20'), jst('2026-09-23T09:00'), 'Asia/Tokyo'));
    assert.equal(m.verifyBeforeDisplay, true);
    assert.ok(m.sources.length > 0);
    assert.ok(m.sources.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.checked_at)));
  });

  test('THE DUBAI CONNECT TRAP: choosing a long layover disqualifies the free hotel', () => {
    const dubai = classifyLayover(
      new Date('2026-09-21T12:00:00Z'), new Date('2026-09-22T04:00:00Z'), 'Asia/Dubai',
    );
    const chosen = matchStopoverProgram('EK', 'DXB', dubai, true);
    const warning = chosen.highlights.find((h) => h.kind === 'hotel_disqualified');
    assert.ok(warning, 'a deliberately chosen EK layover must warn, not promise');
    assert.match(warning.text, /no shorter connection/i);
    assert.match(warning.text, /budget for the hotel/i);

    // Not chosen by the passenger -> the hotel may genuinely apply.
    const forced = matchStopoverProgram('EK', 'DXB', dubai, false);
    assert.ok(!forced.highlights.some((h) => h.kind === 'hotel_disqualified'));
  });

  test('an unknown requires_no_shorter_connection is hedged, never promised', () => {
    const ist = classifyLayover(
      new Date('2026-09-21T06:00:00Z'), new Date('2026-09-22T04:00:00Z'), 'Europe/Istanbul',
    );
    const m = matchStopoverProgram('TK', 'IST', ist, true);
    const hotel = m.highlights.find((h) => h.kind.startsWith('hotel'));
    assert.ok(hotel);
    assert.match(hotel.text, /may/i, 'hedged language required for unverified hotel terms');
  });

  test('EVA is surfaced as unofficial, with no guarantee implied', () => {
    // >24h so it clears the stopover threshold; below it, nothing should surface.
    const tpe = classifyLayover(
      new Date('2026-09-21T02:00:00Z'), new Date('2026-09-22T23:00:00Z'), 'Asia/Taipei',
    );
    const m = matchStopoverProgram('BR', 'TPE', tpe);
    const u = m.highlights.find((h) => h.kind === 'unofficial');
    assert.ok(u);
    assert.match(u.text, /no guarantee/i);
  });

  test('no match when the carrier does not serve that airport as a hub', () => {
    assert.equal(matchStopoverProgram('NH', 'LHR', overnightTokyo), null);
    assert.equal(matchStopoverProgram('ZZ', 'HND', overnightTokyo), null);
  });
});

describe('the 24-hour stopover boundary', () => {
  const tokyo = (fromIso, toIso) => classifyLayover(new Date(fromIso), new Date(toIso), 'Asia/Tokyo');

  test('a 16h overnight does NOT trigger the free-stopover programme', () => {
    // The industry defines a stopover as >24h. ANA says so explicitly. Claiming a
    // free stopover on a 16h connection would be false.
    const m = matchStopoverProgram('NH', 'NRT', tokyo('2026-10-13T07:25:00Z', '2026-10-14T00:00:00Z'));
    assert.ok(!m.highlights.some((h) => h.kind === 'free_stopover'),
      'must not advertise a free stopover below the 24h threshold');
    const below = m.highlights.find((h) => h.kind === 'below_stopover_threshold');
    assert.ok(below, 'should explain why, and how to qualify');
    assert.match(below.text, /connection, not a stopover/i);
    assert.match(below.text, /no fare premium/i);
    assert.match(below.text, /Extend past 24h/i);
  });

  test('past 24h it does trigger', () => {
    const m = matchStopoverProgram('NH', 'NRT', tokyo('2026-10-13T07:25:00Z', '2026-10-15T00:00:00Z'));
    const free = m.highlights.find((h) => h.kind === 'free_stopover');
    assert.ok(free, 'a 40h break is a stopover and should surface the programme');
    assert.ok(!m.highlights.some((h) => h.kind === 'below_stopover_threshold'));
  });

  test('exactly 24h is still a connection, not a stopover', () => {
    const m = matchStopoverProgram('NH', 'NRT', tokyo('2026-10-13T00:00:00Z', '2026-10-14T00:00:00Z'));
    assert.ok(!m.highlights.some((h) => h.kind === 'free_stopover'), 'the rule is MORE than 24h');
  });

  test('EVA is only surfaced as unofficial above the threshold too', () => {
    const short = matchStopoverProgram('BR', 'TPE',
      classifyLayover(new Date('2026-10-13T10:20:00Z'), new Date('2026-10-14T00:50:00Z'), 'Asia/Taipei'));
    assert.ok(!short?.highlights.some((h) => h.kind === 'unofficial'));
  });
});

describe('findGateways input guards', () => {
  const { findGateways } = network;

  test('the same city as origin and destination is not a journey', () => {
    // Without the guard this returns SEA → anywhere → SEA round trips, and the
    // detour filter cannot catch them because the nonstop distance is zero.
    assert.deepEqual(findGateways('SEA', 'SEA'), []);
  });

  test('metro codes collapse to the same city too', () => {
    assert.deepEqual(findGateways('HND', 'TYO'), []);
    assert.deepEqual(findGateways('TYO', 'NRT'), []);
  });

  test('an unknown airport returns nothing rather than throwing', () => {
    assert.deepEqual(findGateways('ZZZ', 'ICN'), []);
    assert.deepEqual(findGateways('SEA', 'ZZZ'), []);
  });

  test('a real pair still works', () => {
    assert.ok(findGateways('SEA', 'ICN').length > 0);
  });
});
