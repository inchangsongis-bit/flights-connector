import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLayover, usableCityHours, describeLayover } from '../layover.mjs';

const TYO = 'Asia/Tokyo';
/** Build a UTC instant from a Tokyo wall-clock time (JST is UTC+9 year-round). */
const jst = (s) => new Date(`${s}:00+09:00`);

describe('classifyLayover', () => {
  test('the motivating case: arrive Tokyo afternoon, leave next morning', () => {
    const c = classifyLayover(jst('2026-09-21T16:20'), jst('2026-09-22T09:00'), TYO);
    assert.equal(c.valid, true);
    assert.equal(c.minutes, 16 * 60 + 40);
    assert.equal(c.isOvernight, true);
    assert.equal(c.nightsRequired, 1);
    assert.equal(c.class, 'long'); // under 24h
    assert.equal(describeLayover(c), 'overnight');
  });

  test('REGRESSION: 23:50 -> 00:20 crosses midnight but is NOT overnight', () => {
    // The original spec said overnight if the local date advances OR the layover
    // is >=8h and touches the night. As OR, this 30-minute hop qualified. It is
    // a sprint between gates, not a night in Tokyo.
    const c = classifyLayover(jst('2026-09-21T23:50'), jst('2026-09-22T00:20'), TYO);
    assert.equal(c.crossesLocalDate, true, 'it really does cross a local midnight');
    assert.equal(c.isOvernight, false, 'but 30 minutes is not an overnight');
    assert.equal(c.nightsRequired, 0, 'and needs no hotel');
    assert.equal(c.class, 'short');
  });

  test('22:00 -> 07:00 is overnight via the night window', () => {
    const c = classifyLayover(jst('2026-09-21T22:00'), jst('2026-09-22T07:00'), TYO);
    assert.equal(c.minutes, 9 * 60);
    assert.equal(c.touchesNight, true);
    assert.equal(c.isOvernight, true);
    assert.equal(c.nightsRequired, 1);
  });

  test('a long daytime sit is long but not overnight', () => {
    // 10:00 -> 22:00, twelve hours, entirely in daylight. No hotel needed.
    const c = classifyLayover(jst('2026-09-21T10:00'), jst('2026-09-21T22:00'), TYO);
    assert.equal(c.minutes, 12 * 60);
    assert.equal(c.class, 'long');
    assert.equal(c.isOvernight, false);
    assert.equal(c.nightsRequired, 0);
    assert.equal(describeLayover(c), 'long layover');
  });

  test('just under the 8h bar is not overnight even crossing midnight', () => {
    const c = classifyLayover(jst('2026-09-21T21:00'), jst('2026-09-22T04:30'), TYO);
    assert.equal(c.minutes, 7 * 60 + 30);
    assert.equal(c.isOvernight, false);
  });

  test('two nights on the ground', () => {
    const c = classifyLayover(jst('2026-09-21T16:00'), jst('2026-09-23T09:00'), TYO);
    assert.equal(c.class, 'stopover');
    assert.equal(c.isOvernight, true);
    assert.equal(c.nightsRequired, 2);
    assert.equal(describeLayover(c), 'overnight, 2 nights');
  });

  test('a backwards or zero layover is invalid, not negative', () => {
    const c = classifyLayover(jst('2026-09-22T09:00'), jst('2026-09-21T16:00'), TYO);
    assert.equal(c.valid, false);
    assert.equal(c.class, 'invalid');
    assert.equal(c.isOvernight, false);
  });

  test('classification uses UTC, so a DST fall-back layover is measured correctly', () => {
    const arrival = new Date('2026-11-01T03:00:00Z');   // 22:00 Oct 31 CDT
    const departure = new Date('2026-11-01T16:00:00Z'); // 10:00 Nov 1 CST
    const c = classifyLayover(arrival, departure, 'America/Chicago');
    assert.equal(c.minutes, 13 * 60, 'thirteen real hours, not the twelve the clock shows');
    assert.equal(c.isOvernight, true);
    assert.equal(c.nightsRequired, 1);
  });
});

describe('usableCityHours', () => {
  test('subtracts sleep, immigration and the round trip to town', () => {
    // 16h40m layover, arriving 16:20. Sleep window 23:00-07:00 eats 8h.
    const h = usableCityHours(jst('2026-09-21T16:20'), jst('2026-09-22T09:00'), TYO,
      { immigrationMinutes: 45, cityTransferMinutes: 60 });
    // 1000 - ~480 asleep - 45 - 120 = ~355 min ≈ 5.9h
    assert.ok(h > 5 && h < 6.5, `expected ~5.9h, got ${h}`);
  });

  test('FR-16: a long layover landing at 01:00 is a night in a terminal, not a city', () => {
    // 14 hours, 01:00 -> 15:00. Elapsed hours flatter it; most of it is the night.
    const h = usableCityHours(jst('2026-09-22T01:00'), jst('2026-09-22T15:00'), TYO);
    const sameLengthDaytime = usableCityHours(jst('2026-09-22T09:00'), jst('2026-09-22T23:00'), TYO);
    assert.ok(h < sameLengthDaytime,
      'the 01:00 arrival must score worse than an identical-length daytime layover');
    assert.ok(h <= 8, `expected the night to be discounted, got ${h}h`);
  });

  test('never returns negative hours', () => {
    const h = usableCityHours(jst('2026-09-21T10:00'), jst('2026-09-21T11:00'), TYO);
    assert.equal(h, 0);
  });
});
