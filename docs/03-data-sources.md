# Data Sources — where each data point comes from

Companion to [`02-data-model.md`](./02-data-model.md). v0.2, rewritten for the
**single-ticket** pivot (D-5).

> **Decisions in force** ([requirements §9](./01-requirements.md#9-decisions)):
> **D-1** global first · **D-2** routings and times first, price comes along for the ride ·
> **D-3** $0 budget, free tiers only · **D-4** personal now, public later · **D-5** single
> ticket only.

> **Confidence marking.** Vendor terms move constantly and several claims below come from
> secondary sources, not vendor pages. Anything marked ⚠️ **verify** must be confirmed
> directly before it is designed around. Researched 2026-09-05.

---

## 1. The market check — no free itinerary source exists

Every source that returns **sold itineraries** was checked. All are out of reach at $0:

| Vendor | Status |
|---|---|
| **Amadeus Self-Service** | Free *production* tier reportedly closed to new signups ~July 2026 ⚠️. Test environment data is a limited subset. Not reachable for us |
| **Duffel** | Real itineraries require **live mode with a funded, verified account**. Transparent pricing, but not $0 |
| **Kiwi Tequila** | Invitation-only for new partners since 2024 ⚠️. Also largely virtual-interlining inventory, which D-5 excludes |
| **Travelpayouts / Aviasales** | Real-time search API requires **50,000 monthly active users**. The free Data API returns price trends only — no itineraries, no times |
| **Skyscanner, Google Flights** | No open API. Partner-gated |
| **OAG / Cirium** | Quote-based, four figures monthly. Evaluation tiers exist ⚠️ but are development-only |

**That is the whole market.** Mode A — discovering long layovers buried inside published
connections — genuinely cannot be built at $0.

## 2. Why Mode B survives anyway

A **requested multi-city stopover is not a connection** ([requirements §8.3](./01-requirements.md#83-why-mode-b-escapes-that--the-v03-insight)).
The airline's maximum connect time applies to connections its engine *builds*; it does not
apply to two origin-destinations the passenger explicitly *asked* for. The airline sells that
as one ticket by design — it is how ANA and JAL free-stopover fares are booked.

So a Mode B candidate is constructible from plain schedule data given two things:

1. **Both flights operate on those dates** → a schedule/FIDS source (§3)
2. **The carriers can be ticketed together** → same carrier or alliance (§5, hand-curated)

We establish that a candidate is **operationally real**. Price, seat availability and fare
rules are confirmed by the carrier's own multi-city search, which we deep-link into. That
boundary is stated on every result (FR-32) and is the honest cost of the $0 path.

## 3. Schedule sources — evaluate on forward depth first

> **The gating question:** how far into the **future** do schedules reach?
> Many aviation APIs are strong on *live status* and weak on *forward schedules*. A source
> that stops at +7 days cannot plan a trip. `scripts/schedule-source-test.mjs --probe`
> answers it in five API calls. **Run it before anything else.**

### AeroDataBox — evaluate first
- **Free tier:** RapidAPI Basic, ~600 units/month, no credit card ⚠️ **verify**
- **Gives:** airport FIDS (departures/arrivals) with scheduled times, airline, flight number,
  destination. Claims 100% US schedule coverage, 86% live coverage
- **Why it fits:** returns **both UTC and local** scheduled times — exactly what NFR-1 needs,
  and it removes the timezone-join problem for schedule data entirely
- **Watch:** 12h max window per request (a full day costs two calls), and forward depth is
  ⚠️ **unverified** — this is what the probe tests
- **Unit budget:** with the offline route graph (§4) doing the fan-out, a search costs ~3 calls.
  600 units/month is workable for a personal tool with aggressive `(airport, date)` caching

### Aviationstack
Free tier ~100 requests/month, no card ⚠️. Very thin for iterating, and forward-schedule depth
is the known weak point. Fallback only.

### GoFlightLabs / FlightAPI
Airport schedule endpoints exist; FlightAPI's window is reportedly ~3 days ahead ⚠️, which
would fail the gating test outright. Check the probe before investing.

### FlightAware AeroAPI
Strong data, forward schedules reportedly up to 12 months. Pay-per-query, not free — but if the
free tiers all fail the depth test, this is where a small paid tier would buy the most.

### OpenSky
Live ADS-B positions only. No schedules, forward or otherwise. Named so nobody rediscovers it.

## 4. Reference data — free and settled

| Data | Source | Licence | Notes |
|---|---|---|---|
| Airports: code, name, city, country, lat/lon, type | **OurAirports** | Public domain | The right default. Filter to `large_airport`/`medium_airport` |
| **Timezone per airport** | lat/lon → tz shapefile (`timezonefinder`, `tz-lookup`) + tzdata | Open | ⚠️ OurAirports has **no** timezone column. Mandatory join, easy to forget, and NFR-1 depends on it |
| Airline names/codes | Vendor payload, or OpenFlights for names only | ODbL | OpenFlights is stale — never use it for routes |
| Metro groups (TYO/OSA/SEL…) | Hand-curated | — | ~30 rows, write it ourselves |
| FX rates | ECB daily feed | Free | P4 only |

**Trap:** airport datasets carry retired and occasionally reassigned IATA codes. Pin a
snapshot, diff on refresh, keep a small override table.

---

## 5. Hand-curated tables — no API exists, and that is fine

All small, all high-leverage, all scoped to the ~30 airports and ~20 carriers we actually
route through. This is a weekend of careful reading, not an integration.

| Table | Rows | Source approach |
|---|---|---|
| **Stopover programs** (§5 of data model) | ~20 | Carrier programme pages. **Highest value-per-row in the project** — ANA/JAL first stopover free, Turkish 20h+ free hotel, Emirates Dubai Connect. ⚠️ Volatile: cite and date every row (LC-4) |
| **`max_through_check_hours`** | ~20 | Carrier baggage pages + verification. AA ~12h (≈16.5h AA/partner), UA ~12h, DL generally through-checks on one ticket, many non-US ~24h. Varies by airport too — store `unknown` rather than guessing (FR-20) |
| **Airport curfews / 24h landside** | ~30 | Airport authority pages. NRT 00:00–06:00, ITM ~21:00 |
| **Airport ↔ city transfer time & cost** | ~30 | Feeds usable-hours scoring (FR-16) — the difference between a night in Tokyo and a night at the gate |
| **Visa / entry** | passport × ~20 countries | Timatic and Sherpa are the commercial standards; community datasets (passport-index) are free but unwarranted. Advisory only, cited and dated (LC-5) |

---

## 6. Recommended path

**Step 1 — Run the probe.** `RAPIDAPI_KEY=... node scripts/schedule-source-test.mjs --probe`.
Five calls, answers the only question that can still sink the project (§3). Free RapidAPI
signup, no card.

**Step 2 — Start the hand-curated tables now, in parallel.** They need no API and no
permission, and the stopover-programme table is the highest value-per-row work in the project
(§5). This is not blocked by Step 1 and should not wait for it.

**Step 3 — Build the offline route graph.** Which carriers fly `A → C` and `C → B`. Free,
offline, and it does the candidate fan-out at zero API cost — which is what makes a ~600
unit/month tier viable at all. Seed from OpenFlights (stale, so verify the routes that matter)
plus hand fixes for the corridors actually used.

**Step 4 — Build P1** behind a thin `getDepartures(airport, date)` seam, so the schedule source
can be swapped when a free tier changes terms.

**Do not:** wait for itinerary-API access, or build Mode A. Both are deferred by D-6, and Mode B
is the actual use case.

### If the probe fails

In descending order of preference: try another free schedule source (§3); pay ~$5/month for a
deeper schedule tier — a far smaller ask than an itinerary API, and it moves D-3 only slightly;
or narrow scope to a bundled, hand-refreshed schedule set for the handful of corridors actually
flown. The last option is unglamorous but entirely workable for a personal tool.

## Sources consulted

- [Amadeus Flight Offers Search](https://developers.amadeus.com/self-service/category/flights/api-doc/flight-offers-search) · [Self-Service pricing](https://developers.amadeus.com/pricing)
- [Duffel test mode](https://duffel.com/docs/api/overview/test-mode/duffel-airways)
- [Cirium Developer Studio](https://www.cirium.com/data/aviation-api/) · [Developer Center pricing](https://helpdesk.cirium.com/hc/en-us/articles/217614768-What-is-the-Developer-Center-pricing)
- [OurAirports data](https://ourairports.com/data/)
- Stopover programmes: [PassRider stopover list](https://www.passrider.com/stopovers/) · [GetStopover — best programmes 2026](https://www.getstopover.com/blog/best-stopover-programs-2026) · [GetStopover — free hotel programmes](https://www.getstopover.com/blog/free-stopover-hotel-programs-2026)
- Baggage on long layovers: [View from the Wing — AA longer connections](https://viewfromthewing.com/american-airlines-will-allow-passengers-to-check-bags-on-longer-connections/) · [FlyerTalk — max connection time for through-checked bags](https://www.flyertalk.com/forum/american-airlines-aadvantage/2068265-maximum-connection-time-through-checked-baggage.html)
- [Travelpayouts — Aviasales Search API access requirements](https://support.travelpayouts.com/hc/en-us/articles/210995808-Requirements-for-Aviasales-Flight-Search-API-access) (50k MAU)
- [AeroDataBox API](https://aerodatabox.com/api) · [FIDS relative time ranges](https://aerodatabox.com/realtive-fids)
- [Aviationstack](https://aviationstack.com/)
- Secondary/aggregator coverage of 2026 API tier changes — treated as unverified leads only
