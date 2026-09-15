import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { entryRules } from '../data-node.mjs';

const { evaluate, upcomingChange, describe: say } = entryRules;

describe('date-dependent entry rules', () => {
  test("Korea: a US passport needs no K-ETA in 2026", () => {
    const r = evaluate('US', 'KR', '2026-12-15');
    assert.equal(r.status, 'visa_free');
    assert.equal(r.schemeWaived, 'K-ETA');
    assert.match(say(r), /waived/i);
  });

  test('Korea: THE SAME TRIP three weeks later needs K-ETA', () => {
    // The temporary exemption lapses 2026-12-31. This is the case a static
    // status field gets wrong, silently, for anyone planning across new year.
    const r = evaluate('US', 'KR', '2027-01-20');
    assert.equal(r.status, 'eta_required');
    assert.equal(r.scheme, 'K-ETA');
    assert.match(say(r), /K-ETA required before departure/i);
  });

  test('Korea: the boundary is exact', () => {
    assert.equal(evaluate('US', 'KR', '2026-12-31').status, 'visa_free');
    assert.equal(evaluate('US', 'KR', '2027-01-01').status, 'eta_required');
  });

  test('a traveller near the boundary is warned before they cross it', () => {
    const w = upcomingChange('US', 'KR', '2026-11-01', 180);
    assert.ok(w, 'expected a warning within the horizon');
    assert.equal(w.from, '2027-01-01');
    assert.equal(w.scheme, 'K-ETA');
    assert.match(w.text, /Travel after that date needs it/);
  });

  test('no warning when the change is already in effect', () => {
    assert.equal(upcomingChange('US', 'KR', '2027-06-01', 180), null);
  });

  test('no warning for a change beyond the horizon', () => {
    assert.equal(upcomingChange('US', 'KR', '2026-01-01', 30), null);
  });
});

describe('Japan', () => {
  test('visa-free for 2026 travel — JESTA is not yet in force', () => {
    const r = evaluate('US', 'JP', '2026-10-13');
    assert.equal(r.status, 'visa_free');
    assert.equal(r.maxStayDays, 90);
  });

  test('JESTA applies once fiscal 2028 arrives', () => {
    const r = evaluate('US', 'JP', '2028-06-01');
    assert.equal(r.status, 'eta_required');
    assert.equal(r.scheme, 'JESTA');
  });
});

describe('hedging toward unknown', () => {
  test('an unlisted passport resolves to unknown, never to visa-free', () => {
    const r = evaluate('ZZ', 'JP', '2026-10-13');
    assert.equal(r.status, 'unknown');
    assert.match(say(r), /check before you go/i);
  });

  test('a country with no rules recorded resolves to unknown', () => {
    const r = evaluate('US', 'QA', '2026-10-13');
    assert.equal(r.status, 'unknown');
  });

  test('an entirely unknown country does not throw', () => {
    const r = evaluate('US', 'XX', '2026-10-13');
    assert.equal(r.status, 'unknown');
    assert.equal(r.confidence, 'none');
  });

  test('every result demands verification and carries its confidence', () => {
    for (const c of ['JP', 'KR', 'SG', 'TW', 'IS']) {
      const r = evaluate('US', c, '2026-10-13');
      assert.equal(r.verifyBeforeTravel, true, `${c} must require verification`);
      assert.ok(['high', 'medium', 'low', 'none'].includes(r.confidence), `${c} confidence`);
    }
  });
});

describe('formalities that are not visas', () => {
  test('Singapore is visa-free but still needs an arrival card', () => {
    const r = evaluate('US', 'SG', '2026-10-13');
    assert.equal(r.status, 'visa_free');
    const card = r.arrivalFormalities.find((f) => /arrival card/i.test(f.name));
    assert.ok(card, 'the SG Arrival Card must surface — visa-free is not the whole answer');
    assert.equal(card.required, true);
  });

  test('Taiwan surfaces its arrival card too', () => {
    const r = evaluate('US', 'TW', '2026-10-13');
    assert.ok(r.arrivalFormalities.some((f) => /TWAC|arrival card/i.test(f.name)));
  });
});

describe('Schengen', () => {
  test('Portugal inherits Iceland\'s rule set rather than duplicating it', () => {
    const pt = evaluate('US', 'PT', '2026-10-13');
    const is = evaluate('US', 'IS', '2026-10-13');
    assert.equal(pt.status, is.status);
    assert.equal(pt.status, 'visa_free');
    assert.equal(pt.schengen, true);
  });

  test('the 90-day allowance is flagged as area-wide, not per country', () => {
    const r = evaluate('US', 'IS', '2026-10-13');
    assert.match(r.stayBasis ?? '', /Schengen/i);
  });
});

describe('rule ordering is enforced, not assumed', () => {
  test('REGRESSION: an open-ended rule must not shadow a future-dated one', () => {
    // Japan's visa_free rule carries no dates and was written above the JESTA
    // rule. Under naive first-match-wins it matched every date, so JESTA could
    // never fire and the app would have said "visa-free" in 2029.
    assert.equal(evaluate('US', 'JP', '2026-10-13').status, 'visa_free');
    assert.equal(evaluate('US', 'JP', '2029-01-01').status, 'eta_required');
  });

  test('the JESTA change is warned about ahead of time', () => {
    const w = upcomingChange('US', 'JP', '2028-01-15', 180);
    assert.ok(w, 'expected a JESTA warning inside the horizon');
    assert.equal(w.scheme, 'JESTA');
  });
});
