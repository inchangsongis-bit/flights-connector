import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { encodeTfs, googleFlightsUrl, TRIP_TYPE, CABIN } from '../tfs.mjs';

/** Minimal protobuf reader, so the encoder is checked against the schema
 *  rather than against itself. */
function decode(buf) {
  const out = [];
  let i = 0;
  const varint = () => { let r = 0; let s = 0; for (;;) { const x = buf[i++]; r |= (x & 0x7f) << s; if (!(x & 0x80)) break; s += 7; } return r; };
  while (i < buf.length) {
    const t = varint();
    const field = t >> 3;
    const wire = t & 7;
    if (wire === 0) out.push({ field, value: varint() });
    else if (wire === 2) { const len = varint(); out.push({ field, bytes: buf.subarray(i, i + len) }); i += len; }
    else break;
  }
  return out;
}
const fromB64Url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const field = (parts, n) => parts.filter((p) => p.field === n);

const LEGS = [
  { from: 'SEA', to: 'NRT', date: '2026-10-13' },
  { from: 'NRT', to: 'ICN', date: '2026-10-15' },
];

describe('tfs encoding matches the documented schema', () => {
  const parts = decode(fromB64Url(encodeTfs(LEGS)));

  test('two legs in field 3', () => {
    assert.equal(field(parts, 3).length, 2);
  });

  test('trip_type in field 19 is MULTI_CITY for two legs', () => {
    assert.equal(field(parts, 19)[0].value, TRIP_TYPE.MULTI_CITY);
  });

  test('a single leg is ONE_WAY, not multi-city', () => {
    const one = decode(fromB64Url(encodeTfs([LEGS[0]])));
    assert.equal(field(one, 19)[0].value, TRIP_TYPE.ONE_WAY);
    assert.equal(field(one, 3).length, 1);
  });

  test('each leg carries its own date, origin and destination', () => {
    const leg = decode(field(parts, 3)[1].bytes);
    assert.equal(field(leg, 2)[0].bytes.toString(), '2026-10-15', 'leg 2 uses ITS date');
    const origin = decode(field(leg, 13)[0].bytes);
    const dest = decode(field(leg, 14)[0].bytes);
    assert.equal(field(origin, 1)[0].value, 1, 'entity_type 1 = IATA airport');
    assert.equal(field(origin, 2)[0].bytes.toString(), 'NRT');
    assert.equal(field(dest, 2)[0].bytes.toString(), 'ICN');
  });

  test('passengers and cabin are carried', () => {
    const two = decode(fromB64Url(encodeTfs(LEGS, { adults: 2, cabin: CABIN.BUSINESS })));
    assert.equal(field(two, 8).length, 2, 'one repeated entry per adult');
    assert.equal(field(two, 9)[0].value, CABIN.BUSINESS);
  });

  test('output is base64url with no padding — it goes in a URL', () => {
    const t = encodeTfs(LEGS);
    assert.ok(!/[+/=]/.test(t), `must not contain +, / or =: ${t}`);
  });
});

describe('bad input never becomes a bad link', () => {
  test('rejects non-IATA codes', () => {
    assert.throws(() => encodeTfs([{ from: 'Seattle', to: 'NRT', date: '2026-10-13' }]), /IATA/);
    assert.throws(() => encodeTfs([{ from: 'SEA', to: null, date: '2026-10-13' }]), /IATA/);
  });

  test('rejects a malformed date', () => {
    assert.throws(() => encodeTfs([{ from: 'SEA', to: 'NRT', date: '13 Oct 2026' }]), /YYYY-MM-DD/);
    assert.throws(() => encodeTfs([{ from: 'SEA', to: 'NRT', date: '' }]), /YYYY-MM-DD/);
  });

  test('rejects no legs at all', () => {
    assert.throws(() => encodeTfs([]), /at least one leg/);
  });
});

test('googleFlightsUrl builds a usable URL', () => {
  const url = googleFlightsUrl(LEGS);
  assert.match(url, /^https:\/\/www\.google\.com\/travel\/flights\?/);
  assert.match(url, /tfs=/);
  assert.match(url, /hl=en/);
});
