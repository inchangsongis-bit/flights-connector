# Data Sources — where each data point comes from

Companion to [`02-data-model.md`](./02-data-model.md).

> **Decisions in force** (see [requirements §9](./01-requirements.md#9-decisions)):
> **D-1** global first · **D-2** routings and times only, no prices in v1 · **D-3** $0 budget,
> free tiers only · **D-4** personal now, public later.
> These narrow this document sharply — §3 (fares) and §5 (hotels) are deferred to P3, and
> §2 is evaluated on *free-tier request quota and forward-schedule depth*, not on price.

> **Confidence marking.** Vendor terms and pricing move constantly and several claims below
> come from secondary sources (aggregator blogs), not vendor pages. Anything marked
> ⚠️ **verify** must be confirmed directly with the vendor before it is designed around.
> Researched 2026-09-05.

---

## 1. Reference data — solved, free

| Data | Source | License | Notes |
|---|---|---|---|
| Airports: code, name, city, country, lat/lon, type | **OurAirports** (`ourairports.com/data/airports.csv`) | Public domain | The right default. ~80k rows, filter to `large_airport`/`medium_airport` |
| **Timezone per airport** | tz shapefile lookup from lat/lon (`timezonefinder`, `tz-lookup`) + system tzdata | Open | ⚠️ OurAirports has **no** timezone column. This join is mandatory and easy to forget |
| Airline codes/names | OpenFlights airlines.dat, or the schedule vendor's own | ODbL | OpenFlights is stale (last meaningful refresh years ago) — use only for names, never for routes |
| Metro groupings (TYO/OSA/SEL…) | Hand-curated | — | ~30 rows. Write it ourselves, it's small and we need it exact |
| FX rates | ECB daily feed / exchangerate.host | Free | |
| US on-time performance | **DOT / BTS On-Time Performance** | Public domain | Free, authoritative, US carriers only — covers UC-1 risk scoring completely |

**Known trap:** airport datasets carry retired and duplicate IATA codes, and occasionally
reassign one. Pin a snapshot, diff it on each refresh, and keep a small override table.

---

## 2. Schedules — the one that decides the project

This is the layer the product lives or dies on (§12 of the data model). Options, roughly
cheapest-first:

### Amadeus Self-Service
- **Gives:** Flight Offers Search (real schedules *and* prices), Flight Availabilities Search
  (all scheduled flights on a route+date, with seats per fare class — close to exactly what
  we want), Flight Status.
- **Coverage:** Global, 400+ carriers. Strong on the UC-2 international case.
- **Cost:** Historically a generous free test quota then pay-as-you-go.
  ⚠️ **verify** — secondary sources claim the free production tier closed to *new* signups
  around July 2026, leaving enterprise-only, while a free test environment remains. The
  vendor's developer portal is not reachable from this environment to confirm. **Check this
  first; it is the pivot point of the whole sourcing decision.**
- **Caveat:** test-environment schedules and prices are not realistic, so a test key cannot
  validate overnight detection.

### Duffel
- **Gives:** Offers with real schedules and bookable fares.
- **Cost:** Publicly posted and refreshingly transparent — ~$3 per confirmed order, ~1% for
  managed content, ~$0.005 per search beyond a 1,500:1 search-to-book ratio. ⚠️ **verify**
- **The trap:** test mode only serves a fictional carrier ("Duffel Airways") with unrealistic
  schedules. **Real schedules require live mode with a funded, verified account.** A
  search-heavy, book-rarely app like ours is exactly the profile that trips the excess-search
  fee, and our fan-out (§4.1 of requirements) makes that worse. Model the search budget
  before committing.

### AeroDataBox
- **Gives:** Airport schedules, flight status, airport/aircraft reference data. Schedules
  without fares.
- **Cost:** Low, via RapidAPI, with a usable small tier. ⚠️ **verify**
- **Fit:** A strong P2 candidate precisely *because* it skips fares. P2 only needs times.

### Aviationstack / FlightAPI / similar
- Cheap, easy, mixed data quality and thin coverage on smaller carriers and future-dated
  schedules. Acceptable for a prototype, risky as a foundation. ⚠️ **verify** future-schedule
  depth specifically — many of these are strong on *live status* and weak on *forward
  schedules*, which is the opposite of what we need.

### FlightAware AeroAPI
- Excellent live status and history, pay-per-query. Forward schedule depth is the thing to
  check. Better as a P4 risk-scoring input than as the P2 schedule spine.

### OAG / Cirium
- The industry-grade answer. Cirium offers a free-transaction Evaluation plan for initial
  development; both are quote-based for production and can run to four figures monthly.
  ⚠️ **verify**
- Realistic only if this becomes a funded product (OQ-5/OQ-6). Their evaluation tiers are
  genuinely worth using to validate the data model even if we never buy.

### Kiwi.com Tequila — worth naming and ruling out
Virtual interlining is *literally this product*, and Tequila would hand us self-transfer
itineraries directly. But public self-serve access closed in 2024 and new partners are
invitation-only as of 2026. ⚠️ **verify** — but plan as though unavailable.

### OpenSky Network — explicitly not this
Live ADS-B positions of aircraft in the air. Free and excellent for what it is; it contains
no forward schedules. Named here only so nobody spends a weekend discovering that.

### Scraping
Buildable, free, and against most airline terms of use. Defensible **only** as a
manually-triggered, build-time refresh of a public route index — never per user search
(LC-1). Fine for a route graph; it will not give reliable dated schedules.

---

## 3. Fares (P3)

Whatever provides schedules in §2 mostly provides fares (Amadeus, Duffel). The unique
requirement is **FR-20's baseline**: the cheapest *through* itinerary A → B on the same
dates. That is a second, ordinary flight search per query, and it is non-negotiable — without
it the app cannot honestly claim a saving.

Bag fees, carry-on rules and seat fees are frequently absent or unreliable in fare payloads,
especially for LCCs. Expect to hand-curate a small carrier fee table for the carriers we
actually route over, and refresh it on a schedule.

---

## 4. Connection rules, curfews, visa (P4)

No good free API exists for any of these. All three are small, high-leverage, hand-curated
tables scoped to the ~30 gateways we actually route through.

| Data | Approach |
|---|---|
| Self-transfer MCT | Our own table (§7 of the data model). Official MCT is published in IATA SSIM / OAG's MCT product, but it describes *airline-protected* connections and must not be reused for self-transfer. Start conservative |
| Airport curfews / overnight closure | Hand-curated from airport authority pages, cited and dated |
| Immigration clearance times | US CBP publishes airport wait times; elsewhere, estimate conservatively and label it an estimate |
| Visa / entry | Timatic (IATA) and Sherpa are the commercial standards. Community datasets (passport-index) are free but unwarranted. Whatever we use: advisory only, cite it, date it, defer to the government |

---

## 5. Hotels (P3)

Only needed to price the night. Amadeus Hotel Search, or a Booking/Expedia affiliate feed, or
— the honest v1 option — a hand-entered per-city typical airport-hotel rate. A rough number
that is labelled rough beats an integration that delays P2.

---

## 6. Recommended path

Under D-1 + D-3 (global coverage, zero budget) the binding constraint is **free-tier request
quota**, and the fix is architectural before it is contractual — see
[requirements §9.1](./01-requirements.md#91-the-tension-d-1-and-d-3-create--and-how-it-resolves):

> **Query by airport-day, not by origin–destination pair.**

Fetch the **departure board** for an airport on a date — one request returning every
departure that day — and build connections locally. A search costs `1 + gateways examined`
requests instead of `2 × N`, boards cache permanently per `(airport, date)` and are shared
across every search, and the gateway list falls out of the board for free (no separate route
graph needed). **Evaluate every vendor below primarily on whether it exposes an
airport-schedule / departure-board endpoint on its free tier**, not on its point-to-point
search.

### Step 1 — Confirm the free tiers (do this before any code)

Both of these are ⚠️ unverified and both could not be reached from this environment:

1. **Amadeus** — does a free tier with *production* quota still exist for new signups, or is
   it test-environment only? Test-environment schedules are unrealistic and therefore useless
   for validating overnight detection. If free production quota survives, Amadeus likely wins
   outright on coverage. If not, it is out under D-3.
2. **AeroDataBox** (via RapidAPI) — free-tier monthly request allowance, and whether the
   airport-schedule endpoint is included in it. This is the most promising fallback precisely
   because it is schedules-without-fares, which is exactly D-2's need, and because its API is
   already shaped around airport-day queries.

Also check **forward-schedule depth** on whichever wins: many cheap aviation APIs are strong
on *live status* and weak on *future* schedules, which is backwards for us. Verify you can
retrieve a departure board for a date 3–6 weeks out, not just today.

### Step 2 — Build P2 against one vendor, behind a thin seam

One interface, roughly `getDepartureBoard(airport, date) -> ScheduledFlight[]`. Every vendor
in §2 can satisfy that shape. Keep the mapping layer honest so swapping vendors is a day's
work — under D-3 the chosen free tier may change terms with little notice, and under D-4 a
paid tier may become viable later.

### Step 3 — Reference data, free and settled

OurAirports + a timezone shapefile join + the hand-curated metro table (§1). No decisions
needed here; it is all public domain or trivially small.

### Step 4 — Defer

Fares (§3), hotels (§5), and the through-fare baseline are P3 under D-2. Connection rules,
curfews and visa (§4) are P4 and hand-curated when they arrive. **Do not** integrate a fare
vendor in v1; it is the single largest cost and complexity item and D-2 removed it.

### Licensing note under D-4

"Personal now, public later" means avoiding any source whose terms would have to be
renegotiated at launch. Prefer public-domain reference data (OurAirports, BTS) and vendors
with a documented commercial tier to graduate into. Specifically: do **not** build the
schedule spine on a scrape, even though it is free and D-4 makes it briefly tempting — it is
against airline terms of use (LC-1), unreliable for dated schedules, and it is the one
dependency that cannot be made public later.

## Sources consulted

- [Amadeus Flight Availabilities Search](https://developers.amadeus.com/self-service/category/flights/api-doc/flight-availabilities-search)
- [Amadeus Self-Service pricing](https://developers.amadeus.com/pricing)
- [Duffel test mode documentation](https://duffel.com/docs/api/overview/test-mode/duffel-airways)
- [Cirium Developer Studio](https://www.cirium.com/data/aviation-api/)
- [Cirium Developer Center pricing](https://helpdesk.cirium.com/hc/en-us/articles/217614768-What-is-the-Developer-Center-pricing)
- [Frontier GoWild pass](https://www.flyfrontier.com/deals/gowild-pass/) and [GoWild FAQ](https://faq.flyfrontier.com/help/gowild-all-you-can-fly-pass-ff07350)
- [OurAirports data](https://ourairports.com/data/)
- Secondary/aggregator coverage of 2026 API tier changes — treated as unverified leads only
