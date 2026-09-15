/**
 * Google Flights `tfs` deep links, including MULTI-CITY.
 *
 * `tfs` is a base64url-encoded protobuf. It is reverse-engineered rather than
 * published, which is why this was initially skipped — but skipping it left the
 * app unable to hand the user a bookable itinerary, which is the entire point of
 * finding one. A fragile link that works is worth more than no link, provided
 * the fragility is stated and a stable fallback sits beside it.
 *
 * Schema (community-documented):
 *
 *   GoogleFlightsTfs
 *     3  repeated FlightLeg legs
 *     8  repeated PassengerType passengers   (1 = adult)
 *     9  Cabin cabin                          (1 = economy)
 *     19 TripType trip_type                   (1 round, 2 one-way, 3 multi-city)
 *
 *   FlightLeg
 *     2  string departure_date   "YYYY-MM-DD"
 *     13 Place  origin
 *     14 Place  destination
 *
 *   Place
 *     1  uint32 entity_type      (1 = IATA airport code)
 *     2  string entity_id        the IATA code
 *
 * The spec notes multi-city "does not reliably open with all legs visible", so
 * callers must keep a fallback and say so.
 *
 * No dependency: protobuf's wire format here is just varints and
 * length-delimited fields.
 */

const WIRE_VARINT = 0;
const WIRE_LEN = 2;

function varint(value) {
  const bytes = [];
  let n = value >>> 0;
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
  return Uint8Array.from(bytes);
}

const concat = (...parts) => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

const tag = (field, wire) => varint((field << 3) | wire);
const varintField = (field, value) => concat(tag(field, WIRE_VARINT), varint(value));
const bytesField = (field, bytes) => concat(tag(field, WIRE_LEN), varint(bytes.length), bytes);
const stringField = (field, value) => bytesField(field, new TextEncoder().encode(value));

/** base64url, unpadded — what the URL expects. */
function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Place { entity_type: 1 (IATA), entity_id: "SEA" } */
const place = (iata) => concat(varintField(1, 1), stringField(2, iata));

/** FlightLeg { departure_date, origin, destination } */
const flightLeg = ({ from, to, date }) => concat(
  stringField(2, date),
  bytesField(13, place(from)),
  bytesField(14, place(to)),
);

export const TRIP_TYPE = { ROUND_TRIP: 1, ONE_WAY: 2, MULTI_CITY: 3 };
export const CABIN = { ECONOMY: 1, PREMIUM_ECONOMY: 2, BUSINESS: 3, FIRST: 4 };

/**
 * @param {Array<{from:string,to:string,date:string}>} legs
 * @param {object} [opts] adults, cabin, tripType
 * @returns {string} the tfs parameter value
 */
export function encodeTfs(legs, opts = {}) {
  if (!legs?.length) throw new Error('encodeTfs: at least one leg is required');
  for (const l of legs) {
    if (!/^[A-Z]{3}$/.test(l.from ?? '') || !/^[A-Z]{3}$/.test(l.to ?? '')) {
      throw new Error(`encodeTfs: legs need 3-letter IATA codes, got ${l.from}→${l.to}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(l.date ?? '')) {
      throw new Error(`encodeTfs: leg date must be YYYY-MM-DD, got ${l.date}`);
    }
  }

  const {
    adults = 1,
    cabin = CABIN.ECONOMY,
    tripType = legs.length > 1 ? TRIP_TYPE.MULTI_CITY : TRIP_TYPE.ONE_WAY,
  } = opts;

  const parts = legs.map((l) => bytesField(3, flightLeg(l)));
  for (let i = 0; i < adults; i += 1) parts.push(varintField(8, 1)); // repeated: one entry per adult
  parts.push(varintField(9, cabin));
  parts.push(varintField(19, tripType));

  return base64url(concat(...parts));
}

/** A full Google Flights URL for these legs. */
export function googleFlightsUrl(legs, opts = {}) {
  const params = new URLSearchParams({ tfs: encodeTfs(legs, opts), hl: 'en' });
  if (opts.currency) params.set('curr', opts.currency);
  return `https://www.google.com/travel/flights?${params.toString()}`;
}
