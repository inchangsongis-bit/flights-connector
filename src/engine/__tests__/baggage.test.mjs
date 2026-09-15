import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { baggageRules } from '../data-node.mjs';

const { throughCheck } = baggageRules;

describe('the 24-hour line governs baggage too', () => {
  test('a 16h Tokyo layover on ANA: the bag goes through', () => {
    const r = throughCheck('NH', 16, { gatewayCountry: 'JP' });
    assert.equal(r.status, 'through_checked');
    assert.equal(r.limitHours, 24);
    assert.match(r.text, /should go through/i);
  });

  test('THE TRAP: the same 16h layover on United does NOT', () => {
    // US carriers cap it around 12h, half the convention elsewhere. Identical
    // layover, opposite answer, and nothing on a booking page says so.
    const r = throughCheck('UA', 16);
    assert.equal(r.status, 'recheck');
    assert.equal(r.limitHours, 12);
    assert.match(r.text, /collect and re-check/i);
  });

  test("American's extended partner limit is a distinct, conditional answer", () => {
    assert.equal(throughCheck('AA', 10).status, 'through_checked');
    const mid = throughCheck('AA', 15);
    assert.equal(mid.status, 'conditional', '15h sits between the 12h base and 16.5h extended limit');
    assert.match(mid.text, /confirm at check-in/i);
    assert.equal(throughCheck('AA', 20).status, 'recheck');
  });

  test('past 24h even a generous carrier wants the bag collected', () => {
    assert.equal(throughCheck('NH', 26).status, 'recheck');
  });
});

describe('hedging', () => {
  test('an unrecorded carrier is unknown, never assumed fine', () => {
    const r = throughCheck('ZZ', 10);
    assert.equal(r.status, 'unknown');
    assert.match(r.text, /Confirm at check-in/i);
  });

  test('a carrier with no published limit is unknown, not unlimited', () => {
    // Delta reportedly through-checks generally, but "reportedly" is not a limit.
    const r = throughCheck('DL', 30);
    assert.equal(r.status, 'unknown');
    assert.equal(r.limitHours, null);
  });

  test('every answer carries its confidence and sources', () => {
    for (const c of ['NH', 'UA', 'AA', 'DL', 'ZZ']) {
      const r = throughCheck(c, 14);
      assert.ok(['high', 'medium', 'low', 'none'].includes(r.confidence), `${c} confidence`);
      assert.ok(Array.isArray(r.sources), `${c} sources`);
    }
  });
});

describe('Korean customs', () => {
  test('an overnight in Korea means handling the bag whatever the tag says', () => {
    const r = throughCheck('KE', 14, { gatewayCountry: 'KR' });
    assert.equal(r.koreanCustoms, true, 'a border rule, independent of the airline policy');
  });

  test('and does not fire elsewhere', () => {
    assert.equal(throughCheck('NH', 14, { gatewayCountry: 'JP' }).koreanCustoms, false);
  });
});
