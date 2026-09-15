import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bookingLinks } from '../data-node.mjs';

const candidate = {
  origin: 'SEA',
  gateway: 'NRT',
  destination: 'ICN',
  leg1: { carrier: 'NH', flightNumber: 'NH 177', departureLocal: '2026-10-13 13:35-07:00' },
  leg2: { carrier: 'NH', flightNumber: 'NH 867', departureLocal: '2026-10-15 09:00+09:00' },
  ticketability: { status: 'same' },
};

describe('the handoff is not a dead end', () => {
  const b = bookingLinks.forCandidate(candidate);

  test('names where the multi-city ticket is actually bought', () => {
    assert.equal(b.carrier.carrierName, 'All Nippon Airways');
    assert.match(b.carrier.url, /^https:\/\/www\.ana\.co\.jp/);
    assert.match(b.carrier.whatItDoes, /not pre-filled/i, 'must not imply it is pre-filled');
  });

  test('gives a pre-filled search per leg, with the right dates', () => {
    assert.equal(b.legs.length, 2);
    assert.match(b.legs[0].search.url, /SEA/);
    assert.match(b.legs[0].search.url, /NRT/);
    assert.match(b.legs[0].search.url, /2026-10-13/);
    assert.match(b.legs[1].search.url, /2026-10-15/, 'leg 2 uses its OWN date, not the search date');
  });

  test('leg dates come from local times, so the date line does not shift them', () => {
    // Leg 2 departs Tokyo on the 15th local. Deriving its date from the search
    // date, or from a UTC instant, would show the 14th.
    assert.equal(b.legs[1].date, '2026-10-15');
  });

  test('offers the itinerary as pasteable text', () => {
    assert.match(b.itineraryText, /SEA → NRT/);
    assert.match(b.itineraryText, /NH 177/);
    assert.match(b.itineraryText, /NRT → ICN/);
    assert.match(b.itineraryText, /NH 867/);
  });
});

describe('the caveat matches the ticketability', () => {
  test('same carrier: book it as ONE multi-city itinerary', () => {
    const b = bookingLinks.forCandidate(candidate);
    assert.match(b.caveat, /ONE multi-city itinerary/);
    assert.match(b.caveat, /not two separate tickets/);
  });

  test('unverified carriers: warn it may become a self-transfer', () => {
    const b = bookingLinks.forCandidate({
      ...candidate,
      leg2: { ...candidate.leg2, carrier: 'KE' },
      ticketability: { status: 'unknown' },
    });
    assert.match(b.caveat, /self-transfer/);
    assert.match(b.caveat, /no protection/);
  });
});

describe('no fabricated deep links', () => {
  test('no multi-city URL is generated for any provider', () => {
    // Google's tfs is a reverse-engineered protobuf and Kayak's multi-city path
    // is undocumented. A link that breaks at the booking step is worse than none.
    const b = bookingLinks.forCandidate(candidate);
    const urls = [b.carrier.url, ...b.legs.map((l) => l.search.url)];
    assert.ok(!urls.some((u) => /tfs=|multi-city|mc-fd/i.test(u)),
      'must not emit an undocumented multi-city format');
  });

  test('every generated link says what it actually does', () => {
    const b = bookingLinks.forCandidate(candidate);
    assert.ok(b.carrier.whatItDoes);
    for (const leg of b.legs) assert.ok(leg.search.whatItDoes);
  });

  test('an unknown carrier yields no booking link rather than a guessed one', () => {
    const b = bookingLinks.forCandidate({ ...candidate, leg1: { ...candidate.leg1, carrier: 'ZZ' } });
    assert.equal(b.carrier, null);
    assert.equal(b.legs.length, 2, 'per-leg searches still work — they are carrier-agnostic');
  });
});
