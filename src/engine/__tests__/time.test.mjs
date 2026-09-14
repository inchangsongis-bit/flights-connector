import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  localParts, localDate, calendarDaysBetween, elapsedMinutes,
  minutesInLocalWindow, intersectsLocalWindow, isoDurationToMinutes, formatMinutes,
} from '../time.mjs';

describe('localParts', () => {
  test('renders a UTC instant in the target zone', () => {
    // 2026-09-21T07:20Z is 16:20 the same day in Tokyo (UTC+9, no DST).
    const p = localParts(new Date('2026-09-21T07:20:00Z'), 'Asia/Tokyo');
    assert.equal(p.date, '2026-09-21');
    assert.equal(p.time, '16:20');
    assert.equal(p.minuteOfDay, 16 * 60 + 20);
  });

  test('midnight renders as hour 0, not 24', () => {
    const p = localParts(new Date('2026-09-21T15:00:00Z'), 'Asia/Tokyo'); // 00:00 next day
    assert.equal(p.hour, 0);
    assert.equal(p.date, '2026-09-22');
  });

  test('crossing the date line puts Seattle a calendar day behind Tokyo', () => {
    const instant = new Date('2026-09-21T07:20:00Z');
    assert.equal(localDate(instant, 'Asia/Tokyo'), '2026-09-21');
    assert.equal(localDate(instant, 'America/Los_Angeles'), '2026-09-21');
    // Same instant, late Seattle evening -> already tomorrow in Tokyo.
    const evening = new Date('2026-09-22T04:00:00Z'); // 21:00 Sep 21 PDT
    assert.equal(localDate(evening, 'America/Los_Angeles'), '2026-09-21');
    assert.equal(localDate(evening, 'Asia/Tokyo'), '2026-09-22');
  });
});

describe('elapsedMinutes across DST', () => {
  test('US autumn fall-back: wall clock understates elapsed time by an hour', () => {
    // DST ends 2026-11-01 in the US. Chicago goes UTC-5 -> UTC-6 at 02:00 local.
    const arrival = new Date('2026-11-01T03:00:00Z');   // 22:00 Oct 31, CDT (UTC-5)
    const departure = new Date('2026-11-01T16:00:00Z'); // 10:00 Nov 1, CST (UTC-6)

    assert.equal(elapsedMinutes(arrival, departure), 13 * 60);

    // The trap: local clock times read 22:00 -> 10:00, which looks like 12h.
    const a = localParts(arrival, 'America/Chicago');
    const d = localParts(departure, 'America/Chicago');
    assert.equal(a.time, '22:00');
    assert.equal(d.time, '10:00');
    const naive = (d.minuteOfDay + 1440) - a.minuteOfDay;
    assert.equal(naive, 12 * 60);
    assert.notEqual(naive, elapsedMinutes(arrival, departure));
  });

  test('US spring-forward: wall clock overstates elapsed time by an hour', () => {
    // DST begins 2026-03-08 in the US.
    const arrival = new Date('2026-03-08T04:00:00Z');   // 22:00 Mar 7, CST (UTC-6)
    const departure = new Date('2026-03-08T15:00:00Z'); // 10:00 Mar 8, CDT (UTC-5)
    assert.equal(elapsedMinutes(arrival, departure), 11 * 60);

    const a = localParts(arrival, 'America/Chicago');
    const d = localParts(departure, 'America/Chicago');
    const naive = (d.minuteOfDay + 1440) - a.minuteOfDay;
    assert.equal(naive, 12 * 60); // wrong by an hour the other way
  });
});

describe('calendarDaysBetween', () => {
  test('counts calendar days, not elapsed time', () => {
    assert.equal(calendarDaysBetween('2026-09-21', '2026-09-22'), 1);
    assert.equal(calendarDaysBetween('2026-09-21', '2026-09-21'), 0);
    assert.equal(calendarDaysBetween('2026-09-30', '2026-10-01'), 1);
    assert.equal(calendarDaysBetween('2026-12-31', '2027-01-01'), 1);
    assert.equal(calendarDaysBetween('2026-02-28', '2026-03-01'), 1); // 2026 is not a leap year
  });
});

describe('minutesInLocalWindow', () => {
  test('counts a wrapping overnight window', () => {
    // 22:00 -> 08:00 Tokyo. Sleep window 23:00-07:00 should capture 8h.
    const from = new Date('2026-09-21T13:00:00Z'); // 22:00 JST
    const to = new Date('2026-09-21T23:00:00Z');   // 08:00 JST next day
    const mins = minutesInLocalWindow(from, to, 'Asia/Tokyo', 23, 7);
    assert.ok(Math.abs(mins - 8 * 60) <= 5, `expected ~480, got ${mins}`);
  });

  test('a daytime layover touches no part of the night window', () => {
    const from = new Date('2026-09-21T01:00:00Z'); // 10:00 JST
    const to = new Date('2026-09-21T09:00:00Z');   // 18:00 JST
    assert.equal(minutesInLocalWindow(from, to, 'Asia/Tokyo', 23, 7), 0);
    assert.equal(intersectsLocalWindow(from, to, 'Asia/Tokyo', 1, 5), false);
  });

  test('a layover longer than a day always touches the window', () => {
    const from = new Date('2026-09-21T01:00:00Z');
    const to = new Date('2026-09-22T05:00:00Z');
    assert.equal(intersectsLocalWindow(from, to, 'Asia/Tokyo', 1, 5), true);
  });
});

describe('isoDurationToMinutes', () => {
  test('parses the shapes vendors actually emit', () => {
    assert.equal(isoDurationToMinutes('PT16H35M'), 995);
    assert.equal(isoDurationToMinutes('PT2H'), 120);
    assert.equal(isoDurationToMinutes('PT45M'), 45);
    assert.equal(isoDurationToMinutes('P1DT2H30M'), 1590);
    assert.equal(isoDurationToMinutes('garbage'), null);
    assert.equal(isoDurationToMinutes(null), null);
  });
});

test('formatMinutes', () => {
  assert.equal(formatMinutes(995), '16h 35m');
  assert.equal(formatMinutes(60), '1h 00m');
  assert.equal(formatMinutes(null), '?');
});
