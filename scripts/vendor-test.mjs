#!/usr/bin/env node
/**
 * Vendor acceptance test — docs/03-data-sources.md §2.
 *
 * The one question that decides whether this product can be built on a vendor:
 *
 *   Does it return itineraries with long and overnight layovers at all?
 *
 * Many search engines apply their own maximum connect time and drop long
 * connections before we ever see the response. If that happens, no amount of
 * local filtering recovers them and the vendor is unusable regardless of how
 * good its free tier is.
 *
 * Usage:
 *   export AMADEUS_API_KEY=...
 *   export AMADEUS_API_SECRET=...
 *   export AMADEUS_ENV=test          # or: production
 *   node scripts/vendor-test.mjs
 *
 * Optional overrides:
 *   ORIGIN=SEA DEST=ICN STOPOVER_CITY=TYO DAYS_OUT=28 node scripts/vendor-test.mjs
 *
 * Requires Node 18+ (built-in fetch). No dependencies, deliberately — the
 * project has not picked a stack yet and this must not prejudge it.
 */

const KEY = process.env.AMADEUS_API_KEY;
const SECRET = process.env.AMADEUS_API_SECRET;
const ENV = process.env.AMADEUS_ENV ?? 'test';
const HOST = ENV === 'production' ? 'https://api.amadeus.com' : 'https://test.api.amadeus.com';

const ORIGIN = process.env.ORIGIN ?? 'SEA';
const DEST = process.env.DEST ?? 'ICN';
const STOPOVER_CITY = process.env.STOPOVER_CITY ?? 'TYO';
const DAYS_OUT = Number(process.env.DAYS_OUT ?? 28);

// Thresholds from docs/01-requirements.md §2 — what counts as interesting.
const LONG_LAYOVER_HOURS = 6;
const TARGET_LAYOVER_HOURS = 10;

if (!KEY || !SECRET) {
  console.error('Missing AMADEUS_API_KEY / AMADEUS_API_SECRET.\n');
  console.error('Get them at https://developers.amadeus.com → register → My Self-Service');
  console.error('Workspace → create an app. Key and secret are issued immediately.');
  process.exit(2);
}

const isoDate = (daysFromNow) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
};

/** Parse an ISO-8601 duration ("PT16H35M", "P1DT2H") into minutes. */
function durationToMinutes(iso) {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(iso);
  if (!m) return null;
  const [, d, h, min] = m;
  return (Number(d ?? 0) * 1440) + (Number(h ?? 0) * 60) + Number(min ?? 0);
}

const fmtDuration = (mins) =>
  mins == null ? '?' : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;

async function getToken() {
  const res = await fetch(`${HOST}/v1/security/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: KEY,
      client_secret: SECRET,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Auth failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

async function search(token, payload) {
  const res = await fetch(`${HOST}/v2/shopping/flight-offers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body?.errors?.map((e) => `${e.title}: ${e.detail ?? ''}`).join(' | ');
    throw new Error(`Search failed (${res.status}): ${detail || JSON.stringify(body)}`);
  }
  return body.data ?? [];
}

/**
 * Layover length without needing timezone data.
 *
 * Amadeus returns local times with no UTC offset, so subtracting the printed
 * clock times is wrong across the date line and DST — exactly the trap called
 * out in NFR-1. But it also returns an ISO-8601 duration for the whole
 * itinerary and for each segment, and those are elapsed times. So:
 *
 *   total layover = itinerary duration − Σ segment durations
 *
 * For a one-stop itinerary that is the single layover, exactly, with no
 * timezone lookup at all. The real app still needs proper UTC handling for
 * display and for multi-stop; this is enough to answer the acceptance test.
 */
function analyseOffer(offer) {
  const itin = offer.itineraries?.[0];
  if (!itin) return null;
  const segs = itin.segments ?? [];
  const total = durationToMinutes(itin.duration);
  const flying = segs.reduce((sum, s) => sum + (durationToMinutes(s.duration) ?? 0), 0);
  if (total == null) return null;

  return {
    stops: segs.length - 1,
    layoverMinutes: total - flying,
    totalMinutes: total,
    connection: segs.length === 2 ? segs[0].arrival.iataCode : segs.slice(0, -1).map((s) => s.arrival.iataCode).join('/'),
    carrier: segs[0].carrierCode,
    price: offer.price?.grandTotal ?? offer.price?.total,
    currency: offer.price?.currency,
    depart: segs[0].departure.at,
    arriveConnection: segs[0].arrival.at,
    departConnection: segs[1]?.departure.at,
    arrive: segs[segs.length - 1].arrival.at,
  };
}

function histogram(offers) {
  const buckets = [
    ['< 2h', (h) => h < 2],
    ['2–6h', (h) => h >= 2 && h < 6],
    ['6–10h', (h) => h >= 6 && h < 10],
    ['10–16h', (h) => h >= 10 && h < 16],
    ['16–24h', (h) => h >= 16 && h < 24],
    ['24h+', (h) => h >= 24],
  ];
  return buckets.map(([label, test]) => {
    const n = offers.filter((o) => test(o.layoverMinutes / 60)).length;
    const bar = '█'.repeat(Math.min(40, n));
    return `    ${label.padEnd(7)} ${String(n).padStart(4)}  ${bar}`;
  }).join('\n');
}

function report(label, offers) {
  const oneStop = offers.map(analyseOffer).filter((o) => o && o.stops === 1);
  const long = oneStop.filter((o) => o.layoverMinutes >= LONG_LAYOVER_HOURS * 60);
  const target = oneStop.filter((o) => o.layoverMinutes >= TARGET_LAYOVER_HOURS * 60);
  const max = oneStop.reduce((m, o) => Math.max(m, o.layoverMinutes), 0);

  console.log(`\n  offers returned:       ${offers.length}`);
  console.log(`  one-stop offers:       ${oneStop.length}`);
  console.log(`  layover >= ${LONG_LAYOVER_HOURS}h:        ${long.length}`);
  console.log(`  layover >= ${TARGET_LAYOVER_HOURS}h:       ${target.length}`);
  console.log(`  longest layover seen:  ${fmtDuration(max)}`);

  if (oneStop.length) {
    console.log('\n  layover distribution:');
    console.log(histogram(oneStop));
  }

  const show = (target.length ? target : long).slice(0, 8);
  if (show.length) {
    console.log('\n  longest layovers found:');
    for (const o of show.sort((a, b) => b.layoverMinutes - a.layoverMinutes)) {
      console.log(
        `    ${o.carrier}  ${ORIGIN} → ${o.connection} → ${DEST}   ` +
        `layover ${fmtDuration(o.layoverMinutes).padEnd(9)} ` +
        `total ${fmtDuration(o.totalMinutes).padEnd(9)} ` +
        `${o.price ?? '?'} ${o.currency ?? ''}`,
      );
      console.log(`        in  ${o.arriveConnection}   out ${o.departConnection}   (local, no offset — see NFR-1)`);
    }
  }

  return { label, offers: offers.length, oneStop: oneStop.length, long: long.length, target: target.length, max };
}

const travelers = [{ id: '1', travelerType: 'ADULT' }];
const searchCriteria = { maxFlightOffers: 250 };

async function main() {
  const departureDate = isoDate(DAYS_OUT);
  const stopoverReturn = isoDate(DAYS_OUT + 1);

  console.log('Vendor acceptance test — docs/03-data-sources.md §2');
  console.log('─'.repeat(70));
  console.log(`  vendor:      Amadeus Self-Service (${ENV})`);
  console.log(`  host:        ${HOST}`);
  console.log(`  route:       ${ORIGIN} → ${DEST}`);
  console.log(`  date:        ${departureDate}  (today + ${DAYS_OUT}d)`);

  const token = await getToken();
  console.log('  auth:        ok');

  // ── Mode A — Discover ────────────────────────────────────────────────────
  // One ordinary search, pulled as wide as the API allows. Do the long
  // layovers survive the vendor's own max-connect-time?
  console.log(`\n${'─'.repeat(70)}\nMODE A — Discover: does a normal search return long layovers?`);
  const modeA = await search(token, {
    currencyCode: 'USD',
    originDestinations: [{
      id: '1',
      originLocationCode: ORIGIN,
      destinationLocationCode: DEST,
      departureDateTimeRange: { date: departureDate },
    }],
    travelers,
    sources: ['GDS'],
    searchCriteria,
  });
  const a = report('Mode A', modeA);

  // ── Mode B — Construct ───────────────────────────────────────────────────
  // The stopover, asked for explicitly as a multi-city single ticket. This is
  // how ANA/JAL free-stopover fares are actually built and priced.
  console.log(`\n${'─'.repeat(70)}\nMODE B — Construct: ${ORIGIN} → ${STOPOVER_CITY} (${departureDate}), ${STOPOVER_CITY} → ${DEST} (${stopoverReturn})`);
  let b = null;
  try {
    const modeB = await search(token, {
      currencyCode: 'USD',
      originDestinations: [
        { id: '1', originLocationCode: ORIGIN, destinationLocationCode: STOPOVER_CITY, departureDateTimeRange: { date: departureDate } },
        { id: '2', originLocationCode: STOPOVER_CITY, destinationLocationCode: DEST, departureDateTimeRange: { date: stopoverReturn } },
      ],
      travelers,
      sources: ['GDS'],
      searchCriteria,
    });
    console.log(`\n  offers returned:       ${modeB.length}`);
    if (modeB.length) {
      const cheapest = modeB
        .map((o) => ({ price: Number(o.price?.grandTotal ?? o.price?.total ?? Infinity), currency: o.price?.currency, carrier: o.validatingAirlineCodes?.[0] }))
        .sort((x, y) => x.price - y.price)[0];
      console.log(`  cheapest stopover:     ${cheapest.price} ${cheapest.currency ?? ''} on ${cheapest.carrier ?? '?'}`);
      console.log(`  → multi-city single-ticket stopovers are sellable on this vendor.`);
    }
    b = modeB.length;
  } catch (err) {
    console.log(`\n  Mode B failed: ${err.message}`);
  }

  // ── Verdict ──────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(70)}\nVERDICT`);
  const passA = a.target > 0;
  const passAWeak = a.long > 0;
  const passB = b != null && b > 0;

  console.log(`  Mode A — long layovers returned:   ${passA ? 'PASS' : passAWeak ? 'WEAK' : 'FAIL'}`);
  console.log(`  Mode B — multi-city stopover:      ${passB ? 'PASS' : 'FAIL'}`);

  if (passA && passB) {
    console.log('\n  Both modes work. This vendor can support the product.');
    console.log('  Next: confirm the free-tier quota, then build P1 behind the');
    console.log('  searchItineraries() seam (docs/03-data-sources.md §6, step 2).');
  } else if (passAWeak) {
    console.log(`\n  Long layovers exist but nothing past ${TARGET_LAYOVER_HOURS}h came back.`);
    console.log('  Inconclusive. Retry on other long-haul pairs before judging —');
    console.log('  try DEST=SIN, DEST=BKK, or ORIGIN=LAX. A vendor-side max-connect-time');
    console.log('  would show as a hard ceiling in the histogram above.');
  } else {
    console.log('\n  No long layovers returned. Before ruling the vendor out:');
    if (ENV === 'test') {
      console.log('  → You are on the TEST environment, whose data is a limited subset.');
      console.log('    A null result here is NOT conclusive. Re-run with');
      console.log('    AMADEUS_ENV=production before drawing any conclusion.');
    }
    console.log('  → Try other routes (DEST=SIN / BKK / IST) to rule out a thin market.');
    console.log('  → If a hard ceiling shows in the histogram across several routes,');
    console.log('    the vendor applies its own max-connect-time and cannot support');
    console.log('    this product. Fall back to Duffel (docs/03-data-sources.md §3).');
  }
  console.log('');
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}\n`);
  process.exit(1);
});
