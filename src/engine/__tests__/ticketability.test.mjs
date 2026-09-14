import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ticketability } from '../ticketability.mjs';
import { matchStopoverProgram } from '../stopover.mjs';
import { classifyLayover } from '../layover.mjs';

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
  test('ANA at Tokyo surfaces the free first stopover', () => {
    const m = matchStopoverProgram('NH', 'HND', overnightTokyo);
    assert.ok(m, 'expected a match for ANA at Haneda');
    const free = m.highlights.find((h) => h.kind === 'free_stopover');
    assert.ok(free, 'expected a free_stopover highlight');
    assert.match(free.text, /first stopover free/i);
    assert.match(free.text, /130/);
  });

  test('carries provenance so the UI can cite and date it', () => {
    const m = matchStopoverProgram('JL', 'NRT', overnightTokyo);
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
    const tpe = classifyLayover(
      new Date('2026-09-21T02:00:00Z'), new Date('2026-09-21T23:00:00Z'), 'Asia/Taipei',
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
