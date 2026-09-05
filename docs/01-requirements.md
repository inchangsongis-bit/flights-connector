# Layover Finder — Requirements & Planning

**Status:** Draft v0.2 — planning only, no implementation, no UI design yet.
**Owner:** @inchangsongis-bit
**Last updated:** 2026-09-05

> **v0.2 pivot.** v0.1 planned a *self-transfer* tool that stitched two separately-booked
> tickets together. That is no longer the product. This app finds **single-ticket
> itineraries that already contain a long or overnight layover**. See §1.3 for what that
> deleted and §9 for what it costs us.

---

## 1. Problem statement

`SEA → NRT → ICN` on one ticket, with 16 hours on the ground in Tokyo, is a real itinerary
that a real airline will really sell you. You can go into the city, sleep, eat, and fly on
the next morning. One booking, one PNR, bags handled by the airline, and if the first flight
is late they rebook you.

**You will almost never see it in a search result.** Not because it doesn't exist — because
every flight search on earth is built to hide it:

- Results sort by **shortest total duration**. A 16-hour layover ranks below every nonstop
  and every tight connection, so it lands pages deep or gets cut by a result limit.
- Default filters cap total journey time. Long-layover itineraries are excluded before you
  ever see them.
- Airlines apply a **maximum connect time** when building itineraries — beyond it, the
  connection isn't offered at all. The long ones that survive are exactly the ones worth
  finding, and nothing surfaces them.
- Metasearch treats a long layover as a *defect to filter out*, never as a *feature to
  search for*. Nobody sells "show me the itineraries with a night in Tokyo."

This app inverts that. The layover is the point, not the penalty.

### 1.1 Motivating case

**Seattle → Seoul, with a night in Japan.** Plenty of nonstops exist. But `SEA → HND`,
sleep in Tokyo, `HND → ICN` the next day is one ticket, sometimes cheaper than the nonstop,
and gets you a free extra city. Nothing on the market will show you that on purpose.

**And it turns out the airlines actively want to sell this.** Research finding, §1.2.

### 1.2 The finding that shapes the product: stopover programs

Multiple carriers *explicitly encourage* this and price it at or near zero:

| Carrier | Offer | Relevance |
|---|---|---|
| **ANA** | First stopover in Japan **free** per direction, second ~$130. 40+ Japanese destinations | Directly serves the SEA → Japan → ICN case |
| **JAL** | First stopover **free** per direction (Tokyo, Osaka, Sapporo, Okinawa + 40 more), second ~$130 | Same |
| **Turkish** | Layover ≥ 20h → free hotel in Istanbul (1 night economy, up to 3 business ex-US). 6–24h → free *Touristanbul* city tour | Free hotel is a cost-model input, not just a perk |
| **Emirates** | *Dubai Connect* — free hotel, meals, transfers on long layovers where no shorter connection exists | |
| **Qatar, Ethiopian, Saudia, Gulf Air** | Free-hotel stopover programs | |

⚠️ Terms, thresholds and cabin eligibility change often and vary by fare — **verify per
carrier before display** (§7).

This reframes the product. It is not a loophole-hunter. It surfaces a thing airlines already
sell, sometimes bundle a free hotel with, and that no search engine exposes. It also means
**"is this carrier's stopover free, and does it come with a hotel?" is a first-class data
point**, not a footnote — it can flip a routing from "costs a hotel night" to "saves one."

### 1.3 What the single-ticket constraint deletes

Roughly two-thirds of v0.1's complexity, all of it the risky part:

| Gone | Why |
|---|---|
| Self-transfer minimum connect times | The airline owns the connection |
| Missed-connection risk modelling, fallback-flight counting | They rebook you, for free |
| Paying for bags twice | One ticket, one bag fee |
| Sequential-booking risk | One booking |
| GoWild day-before booking window, early-booking charges | Not applicable — see §9 |
| Virtual interlining / guarantee questions | Not building it |
| The 2×N search fan-out problem | One search returns whole itineraries — **this is the big one, see §8.1** |

### 1.4 What it is not

- **Not self-transfer.** No stitching two separate bookings together. (Possible future mode —
  §10, OQ-B.)
- **Not hidden-city ticketing.** Booking past your real destination and walking out. Violates
  every contract of carriage. Permanently out of scope.
- **Not a booking engine.** v1 hands off to the airline or an OTA. We never take money.

---

## 2. Definitions

| Term | Meaning here |
|---|---|
| **Segment / leg** | One takeoff and landing under one flight number |
| **Itinerary** | The whole `A → C → B` journey, sold as **one ticket, one PNR** |
| **Layover** | Ground time at C between segments, measured in **UTC** |
| **Long layover** | 6–12h, same local calendar day at C. City visit, no hotel |
| **Overnight layover** | Requires a night's sleep at C. Formal rule in §2.1 |
| **Stopover** | ≥ 24h at C. Often a distinct fare product with its own rules and price |
| **MaxCT** | Maximum connect time — the airline-side cap that hides these itineraries from normal search. The thing we are working around |
| **Through-checked** | Bags tagged to the final destination. Usually yes on one ticket, **but not always on long layovers** — §5.4 |
| **Metro / city group** | TYO = {NRT, HND}, OSA = {KIX, ITM}, SEL = {ICN, GMP}, NYC, LON |

### 2.1 Formal definition of "overnight"

At connection airport C, evaluated in C's IANA timezone, a layover is **overnight** when
either:

- (a) segment 2's scheduled local departure **date** is later than segment 1's scheduled
  local arrival **date**; or
- (b) the layover is ≥ `MIN_OVERNIGHT_HOURS` (default 8) **and** the interval intersects
  local 01:00–05:00 at C.

(b) catches a 22:00 → 07:00 connection; the date test alone would also flag a useless
23:50 → 00:20 hop, which (a)+(b) together reject.

`nights_required` = local calendar dates spanned. Drives hotel cost, stopover-program
eligibility, **and whether the traveller must legally enter the country** (§5.5).

---

## 3. Users and jobs

**Primary user: the person themselves.** Flexible, curious, would rather have a night in
Tokyo than four hours in an airside food court. Wants the option surfaced, not defended.

1. **JTBD-1** — "Show me the one-ticket itineraries from A to B that have a long or overnight
   layover somewhere interesting."
2. **JTBD-2** — "Let me *ask* for a stopover in a specific city, on one ticket."
3. **JTBD-3** — "Tell me if this carrier's stopover is free, and whether they'll give me a
   hotel."
4. **JTBD-4** — "Tell me what I need to know to actually use the layover: can I enter the
   country, do I get my bag, is there time to reach the city."
5. **JTBD-5** — "Take me somewhere I can book it."

JTBD-1 and JTBD-2 are two genuinely different search modes. See §8.

---

## 4. Search modes

### Mode A — Discover (the MVP)

Ordinary `A → B` itinerary search on the user's dates. Pull results **wide** rather than
sorted-by-best, then filter and re-rank locally for layover length. Surfaces long layovers
the user didn't know existed, in cities they didn't think of.

One upstream request per search. This is the whole MVP and it is cheap.

### Mode B — Construct (stopover)

User names the city: "Seattle to Seoul, one night in Tokyo." Issue a **multi-city
single-ticket** search — `SEA → TYO` on date D, `TYO → ICN` on date D+1 — which is how
stopovers are actually sold and priced, and how ANA/JAL free-stopover fares get built.

Candidate cities come free from Mode A's own results (§8.1), so this needs no extra data
source. One request per city the user actually asks about — typically one to three, not forty.

---

## 5. Functional requirements

### 5.1 Input

- **FR-1** Origin and destination, as airport **or metro** code (TYO ⇒ NRT and HND).
- **FR-2** Departure date + flexibility window (± N days). Long-layover itineraries are often
  weekday-specific; flexibility is not optional. Note each extra day is another request.
- **FR-3** Return date, optional. v1 may treat directions independently.
- **FR-4** Passengers (adults, v1). Checked bag count — one fee now, but see FR-19.
- **FR-5** Passport nationality — required for §5.5. Kept client-side (NFR-6).
- **FR-6** *(Mode B)* Desired stopover city and number of nights.

### 5.2 Layover preferences

- **FR-7** Layover class filter: `any` / `long (6–12h)` / `overnight` / `stopover (24h+)`.
- **FR-8** Minimum and maximum layover hours.
- **FR-9** Preferred / excluded layover cities.
- **FR-10** Carrier allow/deny; alliance filter.
- **FR-11** Maximum stops — 1 in v1.
- **FR-12** "Only show stopover-program carriers" toggle (§1.2) — high-value, cheap to build.

### 5.3 The engine

- **FR-13 Compute every layover in UTC.** Convert both instants using each airport's IANA
  timezone on that date. Never subtract local clock times. Seattle → Tokyo → Seoul crosses
  both the date line and, seasonally, a DST boundary.
- **FR-14 Classify** each layover per §2.1, and compute `nights_required`.
- **FR-15 Rank by layover value, not by brevity** — the inversion that defines the product.
  Ranking inputs: layover length within the user's preferred band, city desirability,
  stopover-program eligibility, arrival/departure times civilised enough to use the city.
- **FR-16 Reject useless layovers.** 14 hours arriving 01:00 and departing 15:00 is not a
  night in Tokyo, it is a night in a terminal. Score usable hours, not elapsed hours.
- **FR-17 Detect airport changes** within a metro (arrive NRT, depart HND). Rare on one
  ticket but real, and it is ~2h and a real cost. Never hide it inside "layover".
- **FR-18 Flag airport curfew / overnight closure** where the traveller would be locked out
  (NRT 00:00–06:00 curfew; ITM closes ~21:00).

### 5.4 Baggage — the surviving footgun

One ticket usually means through-checked bags. **Long layovers are the documented
exception**, and the limits are lower than people expect:

- American: 12h (raised to ~16.5h on AA and AA-to-partner) · United: ~12h · Delta: generally
  through-checks on a single ticket · many non-US carriers: ~24h.
  ⚠️ **verify per carrier** — these vary by carrier *and* by airport.

- **FR-19** Store a per-carrier `max_through_check_hours`. When the layover exceeds it, warn
  the user they will collect and re-check their bag, and add that time.
- **FR-20** Where the value is unknown, say "unknown — confirm with the carrier". Never guess.

### 5.5 Entry and visa

An overnight layover means **leaving the airside transit area and entering the country**.
Transit-without-visa provisions do not apply.

- **FR-21** For `(passport_country, layover_country)` resolve `visa_free` / `eta_required`
  (K-ETA, ESTA, ETIAS, eTA) / `visa_required` / `not_permitted`, and flag anything unclean.
- **FR-22** Legal-consequence data: cite the source, show its date, and always defer to the
  official government site.
- **FR-23** If the layover is short enough to stay airside, say so — the visa question may
  then not arise at all.

### 5.6 Stopover programs

- **FR-24** Per-carrier stopover-program table (§1.2): free-stopover eligibility, second-
  stopover cost, free-hotel threshold hours, cabin restrictions, city tours, booking method.
- **FR-25** When a result qualifies, surface it prominently — "ANA: first stopover free" or
  "Turkish: 20h+ layover includes a hotel" is often the single most decision-relevant fact
  on the screen.
- **FR-26** Feed free hotels into the cost model as a **negative** cost.

### 5.7 Output

- **FR-27** Per result: both segments with local times and timezones, layover length and
  class, nights required, usable city hours, stopover-program status, bag warning, visa
  status.
- **FR-28** Compare against the fastest normal itinerary — "3h longer, $40 cheaper, and a
  night in Tokyo" is the sentence the product exists to produce.
- **FR-29** Deep link to book.
- **FR-30** Provenance: source and freshness on every result (NFR-5).
- **FR-31** Honest empty state explaining *why* — no long-layover itinerary published, all
  layovers unusable hours, visa-blocked. "No results" alone is useless.

---

## 6. Non-functional requirements

- **NFR-1 Time correctness is the top quality bar.** Store UTC + IANA zone, always. Never a
  bare local time, never a fixed offset. Derive the `+1 day` marker; never trust a feed's.
- **NFR-2 Latency** < 3s for first results.
- **NFR-3 Request frugality.** Under D-3 (§9) the free-tier quota is the binding constraint.
  Mode A is one request per search — protect that. Cache aggressively by `(A, B, date)`.
- **NFR-4 Graceful degradation.** Enrichment (stopover programs, visa, bags) is local data;
  if the itinerary source is down, say so plainly rather than showing a blank page.
- **NFR-5 Provenance** on every displayed figure.
- **NFR-6 Privacy.** Passport nationality is collected only for FR-21. Client-side, never
  logged, never sent to a third party.
- **NFR-7 Accessibility** — keyboard navigable, screen-reader labelled, WCAG AA.
- **NFR-8 Mobile first.**

---

## 7. Legal and compliance

- **LC-1** No scraping of airline sites for itineraries. Use a licensed/API source. A
  hand-refreshed read of a public reference page is acceptable for slow reference data only.
- **LC-2** Respect the itinerary vendor's caching and redistribution terms.
- **LC-3** No hidden-city ticketing, ever.
- **LC-4** Stopover-program terms (§1.2) change frequently and vary by fare and cabin.
  Present them as "verify with the carrier", dated and cited — never as a guarantee.
- **LC-5** Visa/entry information is advisory. Cite, date, defer to the government.
- **LC-6** Personal-use now, public later (§9, D-4) — avoid any source whose licence would
  have to be renegotiated at launch.

---

## 8. Architecture consequences

### 8.1 The fan-out problem is gone — and last version's fix is now wrong

v0.1 faced a `2 × N` request explosion (price `A → C` and `C → B` for every candidate gateway
C) and solved it by querying **airport-day departure boards** and assembling connections
locally.

**That approach is now actively wrong and should not be built.** A departure board tells you
a flight leaves NRT at 09:00. It cannot tell you whether `SEA → NRT → ICN` is *sold as one
ticket* — which is now the entire premise. Locally-assembled connections are self-transfers
by construction, and self-transfer is what we just cut.

The correct shape is the ordinary one:

> **Ask the vendor for whole itineraries. Filter and re-rank locally.**

- Mode A = **one** request per `(origin, destination, date)`. The vendor does the routing;
  we do the sorting the vendor refuses to do.
- Candidate stopover cities for Mode B **fall out of Mode A's results for free** — the set of
  connection points anyone routes you through. No route graph, no extra source.
- Mode B = one multi-city request per city the user asks about.

This is dramatically kinder to a free tier than v0.1's plan, and simpler to build.

### 8.2 Pull wide, rank locally

The one place we must fight the vendor: it will return the "best" (shortest, cheapest) offers
by default, which are precisely the ones we don't want. Request the maximum offer count
available, and where the API exposes a max-connect-time or duration parameter, push it out.
**Verify during vendor evaluation that long-layover itineraries appear in results at all** —
if a vendor's engine applies its own MaxCT and drops them, that vendor is unusable no matter
how good its free tier is. This is the single most important vendor test.

---

## 9. Decisions

| # | Decision | Note |
|---|---|---|
| **D-1** | Global / international first | Unchanged. UC is Seattle → Japan → Seoul |
| **D-2** | Routings and times first; prices are a bonus | Softened — single-ticket search returns a price *with* the itinerary, so basic pricing is nearly free. The FR-28 comparison is now cheap |
| **D-3** | $0 data budget, free tiers only | Now far more achievable — §8.1 cut request volume by an order of magnitude |
| **D-4** | Personal tool now, public later | Unchanged |
| **D-5** | **Single ticket only** | *New, v0.2.* The defining constraint |

### 9.1 Consequence: Frontier and GoWild drop out of scope

This needs saying plainly, since Frontier was the original starting point.

The GoWild case was inherently a **self-transfer** case — the premise was that Frontier
*doesn't* publish `A → C → B` as one sellable itinerary, so you'd book two GoWild segments
yourself. Under D-5 that is out of scope by definition. Frontier is also a point-to-point
carrier with few published connections and no stopover programme, so single-ticket
long-layover itineraries on Frontier are rare.

**Nothing is lost that D-5 didn't deliberately cut**, and the GoWild-specific research still
stands recorded (the day-before booking window, the early-booking charge) should self-transfer
come back as Mode C. Flagged as OQ-B.

---

## 10. Open questions

- **OQ-A — Wording.** "Overnight layovers in cities of their origin" is read here as
  *intermediate* cities en route, per the Seattle → Tokyo → Seoul example. Confirm.
- **OQ-B — Self-transfer later?** Keep as a possible Mode C (revives the Frontier case), or
  drop permanently? Affects whether the data model keeps hooks for it.
- **OQ-C — Default ranking** under FR-15. Layover length, city desirability, usable hours, or
  price? Probably user-selectable, but the default matters most.
- **OQ-D — Date flexibility depth** (FR-2). Each extra day is another request. Suggest ± 3.
- **OQ-E — Layover-city desirability.** Curated ("worth a night") list, or neutral? Curation
  is opinionated but is arguably the product's taste.
- **OQ-F — Platform.** Web only, or web plus mobile?

---

## 11. Phasing

| Phase | Delivers | Answers |
|---|---|---|
| **P1 — MVP** | Mode A. One itinerary search, UTC-correct layover computation, overnight classification, rank-by-layover | "Which one-ticket routings let me spend a night somewhere on the way?" |
| **P2** | Mode B multi-city stopover search; candidate cities from P1 results | "Book me Seattle → Seoul with a night in Tokyo" |
| **P3** | Stopover-program table, bag through-check warnings, visa/entry | "Is the stopover free, do I get my bag, can I enter?" |
| **P4** | Hotel cost, usable-hours scoring, city desirability, comparison baseline | "Is it worth it?" |
| **P5** | Saved searches, alerts, booking handoff polish | |

**P1 is a genuinely small MVP** — one API call, correct time maths, and a sort order nobody
else offers.

---

## 12. Success criteria

**P1.** For `SEA → ICN, departing in 3 weeks`, the app returns one-ticket itineraries via
Tokyo, Osaka or Taipei with layovers of 10h+, shows each layover's real length and local
arrival/departure times (correct across the date line and DST), classifies which are
overnight, and ranks the most usable first — where every mainstream search engine buries
them or drops them entirely.

**P3.** The same results say "ANA — first stopover in Japan free", warn that a 16-hour
layover may exceed the carrier's through-check limit, and confirm a US passport enters Japan
visa-free — each cited and dated.
