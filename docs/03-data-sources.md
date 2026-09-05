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

## 1. What changed from v0.1 — and what to un-build

v0.1 recommended fetching **airport-day departure boards** and assembling connections
locally, to dodge a `2 × N` request explosion.

**Do not build that.** Under D-5 it is the wrong tool. A departure board tells you a flight
leaves NRT at 09:00; it cannot tell you whether `SEA → NRT → ICN` is **sold as one ticket**,
which is now the entire premise. Anything assembled locally from boards is a self-transfer by
construction — exactly what D-5 cut.

The replacement is the ordinary shape, and it is cheaper anyway:

> **Ask a vendor for whole itineraries. Filter and re-rank locally.**

One request per `(origin, destination, date)`. The vendor does the routing; we do the sort
order it refuses to offer. This cut request volume by roughly an order of magnitude versus
v0.1 and makes D-3 comfortably achievable.

---

## 2. The one vendor test that matters

Before comparing free tiers, coverage, or anything else, answer this:

> **Does the vendor return itineraries with long and overnight layovers at all?**

Many search engines apply their own **maximum connect time** and drop long connections before
you ever see the response. If a vendor does that, no amount of local filtering recovers them,
its free tier is irrelevant, and the product cannot be built on it.

**Concrete test:** request `SEA → ICN` for a date ~4 weeks out, ask for the maximum number of
offers the API allows, and check whether anything with a 10h+ layover in Japan or Taiwan comes
back. Then repeat as a **multi-city** request (`SEA → TYO` day D, `TYO → ICN` day D+1) to
confirm Mode B works. Both must pass.

Secondary checks, in order:
1. Does it expose a max-connect-time / max-duration parameter we can push outward?
2. How many offers per response, and can we page for more? (We need breadth, not the "best" few.)
3. Free-tier monthly request quota.
4. Does it return **timezone or UTC** per segment, or only local times? Local-only means we
   join timezones ourselves from §4 — workable, but confirm it up front.
5. Multi-city / open-jaw support (Mode B, P2).

---

## 3. Itinerary vendors

### Amadeus Self-Service — evaluate first
- **Gives:** Flight Offers Search — whole itineraries with segments, times and prices.
  Supports multi-city. Global, 400+ carriers, strongest fit for D-1.
- **Cost:** ⚠️ **verify.** Secondary sources claim the free *production* tier closed to new
  signups around July 2026, leaving a free test environment plus enterprise. The developer
  portal was unreachable from this environment. **This is the pivot point of the whole
  sourcing decision — check it first.**
- **Caveat:** test-environment schedules and prices are unrealistic, so a test key cannot
  validate §2. You need production access to know whether the product works.

### Duffel
- **Gives:** Real bookable offers with full segment detail. Multi-city supported.
- **Cost:** Publicly posted — ~$3 per confirmed order, ~1% managed content, ~$0.005 per search
  beyond a 1,500:1 search-to-book ratio. ⚠️ **verify**
- **Now a much better fit than in v0.1.** D-5 collapsed our request volume, so the excess-search
  fee that was alarming at `2 × N` per search is far less threatening at one.
- **The trap:** test mode serves only a fictional carrier ("Duffel Airways") with unrealistic
  schedules. **Real itineraries require live mode with a funded, verified account.** Under D-3
  that is a genuine obstacle — a funded account is not $0, even if searches are cheap.

### Kiwi.com Tequila — still worth naming, still ruled out
Would return exactly this shape, but public self-serve access closed in 2024 and new partners
are invitation-only as of 2026 ⚠️ **verify**. Note also that much of Kiwi's inventory is
*virtual interlining* — self-transfer — which D-5 excludes. Plan as unavailable.

### Skyscanner / Google Flights
No open API for this use case; partner/affiliate gated. Google Flights has no public search
API. Not viable.

### AeroDataBox, Aviationstack, FlightAware, OpenSky — no longer candidates
All were considered in v0.1 for **schedules** (departure boards). Under D-5 we need
**sold itineraries**, which none of them provide. AeroDataBox remains useful only as
airport reference data (§4). OpenSky is live ADS-B positions and was never a fit — noted so
nobody spends a weekend rediscovering that.

### OAG / Cirium
Quote-based, four figures monthly for production; Cirium offers a free-transaction Evaluation
plan ⚠️ **verify**. Out of reach under D-3, but the evaluation tier is worth using to validate
the data model even if we never buy.

---

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

**Step 1 — Run the §2 vendor test before writing any application code.**
Get an Amadeus key first and answer the two questions together: does a usable free tier exist,
and does it return long-layover itineraries for `SEA → ICN`? Those two answers decide the
architecture. If Amadeus is out under D-3, price out Duffel live mode as the fallback and
decide whether funding an account is acceptable — it is the main thing that could force D-3 to
move.

**Step 2 — Build P1 behind a thin seam.**
One interface, roughly `searchItineraries(origin, destination, date) -> ItineraryOffer[]`, plus
a multi-city variant for P2. Every candidate vendor can satisfy that shape. Keep the mapping
layer honest so a vendor swap is a day's work — under D-3 a free tier can change terms with
little notice, and under D-4 a paid tier may become viable later.

**Step 3 — Reference data.**
OurAirports + timezone shapefile join + the hand-written metro table. No decisions needed.

**Step 4 — Curate the tables in §5.**
Stopover programmes first — they are the highest-leverage rows in the project and they need no
vendor at all, so this work can proceed in parallel with Step 1 and is not blocked by it.

**Do not:** build departure-board assembly (§1), integrate a separate schedule API, or build a
route graph. Under D-5 all three are solved by the itinerary vendor.

---

## Sources consulted

- [Amadeus Flight Offers Search](https://developers.amadeus.com/self-service/category/flights/api-doc/flight-offers-search) · [Self-Service pricing](https://developers.amadeus.com/pricing)
- [Duffel test mode](https://duffel.com/docs/api/overview/test-mode/duffel-airways)
- [Cirium Developer Studio](https://www.cirium.com/data/aviation-api/) · [Developer Center pricing](https://helpdesk.cirium.com/hc/en-us/articles/217614768-What-is-the-Developer-Center-pricing)
- [OurAirports data](https://ourairports.com/data/)
- Stopover programmes: [PassRider stopover list](https://www.passrider.com/stopovers/) · [GetStopover — best programmes 2026](https://www.getstopover.com/blog/best-stopover-programs-2026) · [GetStopover — free hotel programmes](https://www.getstopover.com/blog/free-stopover-hotel-programs-2026)
- Baggage on long layovers: [View from the Wing — AA longer connections](https://viewfromthewing.com/american-airlines-will-allow-passengers-to-check-bags-on-longer-connections/) · [FlyerTalk — max connection time for through-checked bags](https://www.flyertalk.com/forum/american-airlines-aadvantage/2068265-maximum-connection-time-through-checked-baggage.html)
- Secondary/aggregator coverage of 2026 API tier changes — treated as unverified leads only
