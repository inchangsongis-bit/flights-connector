# Overnight Connector — Requirements & Planning

**Status:** Draft v0.1 — planning only, no implementation, no UI design yet.
**Owner:** @inchangsongis-bit
**Last updated:** 2026-09-05

---

## 1. Problem statement

Airlines sell you a single ticket A → B. Sometimes that ticket is expensive, or the
routing you want simply is not published as a sellable itinerary. But two *separate*
tickets — A → C and C → B — often exist, are cheaper, and are bookable.

Search engines do not show these because:

- They only sell what the airline's own reservation system publishes as a connection.
- Two carriers with no interline agreement can never appear as one itinerary.
- A connection longer than the airline's maximum connect time (usually 4–24h) is dropped
  from results entirely — which is exactly the *overnight* connection we want to find.

This app finds those routings and tells the user whether they are actually feasible.

### 1.1 Two motivating use cases

**UC-1 — Save money on a US domestic budget network (Frontier GoWild).**
The GoWild pass makes individual Frontier segments very cheap, but Frontier does not
publish a nonstop on every city pair, and its own site will not build a two-segment
GoWild itinerary. Wanting SEA → MCO when only SEA → DEN and DEN → MCO exist as
separately-bookable GoWild segments is the core case.

**UC-2 — Deliberate overnight stopover on a long-haul trip.**
SEA → ICN has plenty of nonstops. But the user wants SEA → NRT/HND/KIX, sleep in Japan,
then Japan → ICN the next day. This is sometimes cheaper than the nonstop and always
gives a free extra city. No mainstream search engine will surface it as an option.

These two cases look similar but need **completely different data**, which is the single
most important finding of this document. See §4.

### 1.2 What this is explicitly NOT

- **Not hidden-city / skiplagging.** Booking A → C → B and walking out at C. That
  violates every airline's contract of carriage and gets accounts closed. Out of scope,
  permanently.
- **Not a booking engine.** v1 hands the user off to the airline or an OTA to buy. We
  never take money or hold inventory.
- **Not a guarantee.** Two separate tickets means no protection when leg 1 is late. The
  product's job is to be *honest* about that, loudly.

---

## 2. Definitions

Precision here matters because the whole product is these distinctions.

| Term | Meaning in this app |
|---|---|
| **Leg / segment** | One takeoff and landing on one flight number. |
| **Through ticket** | One PNR covering A → B. Airline owns the connection; misconnect is their problem. |
| **Self-transfer** | Two independent PNRs. User owns the connection; misconnect is the user's problem and cost. |
| **Virtual interlining** | A third party (e.g. Kiwi) combines non-interlining carriers and sells its own missed-connection guarantee on top. We are *not* doing this — no guarantee to sell. |
| **Connection point / gateway** | Airport C, the intermediate stop. |
| **Layover** | Time on the ground at C, measured in **UTC**, between leg 1 arrival and leg 2 departure. |
| **Long layover** | 6–12h, same local calendar day at C. User can leave the airport, no hotel. |
| **Overnight layover** | Requires a night's sleep at C. Formal rule in §2.1. |
| **Stopover** | ≥ 24h at C. A deliberate mini-trip, not a connection. |
| **Metro / city group** | IATA metropolitan code covering several airports — TYO = {NRT, HND}, OSA = {KIX, ITM, UKB}, SEL = {ICN, GMP}, NYC, WAS, LON. Arriving at one and departing another is a *different, much harder* connection. |
| **MCT** | Minimum Connect Time. The airline's published figure. **Not applicable to self-transfer** — see §5.3. |

### 2.1 Formal definition of "overnight"

A connection at airport C is classified **overnight** when either condition holds, with
all times evaluated in C's IANA timezone:

- (a) leg 2's scheduled local departure **date** is later than leg 1's scheduled local
  arrival **date**; **or**
- (b) the layover is ≥ `MIN_OVERNIGHT_HOURS` (default 8) **and** the layover interval
  intersects local 01:00–05:00 at C.

Condition (b) exists to catch a 22:00 → 07:00 connection that crosses midnight but which
some data sources will render awkwardly, and to reject a technically-crosses-midnight
23:50 → 00:20 connection that is not an overnight at all.

Derived from this: `nights_required = ceil()` of local calendar dates spanned, which
drives hotel cost and, critically, **whether the user must legally enter the country**.

---

## 3. Users and jobs

**Primary user: the person themselves.** Price-sensitive, flexible on routing, willing to
carry their own bags through immigration to save money or see an extra city. Tolerant of
risk *if it is disclosed*. Not tolerant of an app that shows a "connection" that turns out
to be impossible.

Jobs to be done, in priority order:

1. **JTBD-1** — "Show me every C where A → C → B is actually flyable on my dates."
2. **JTBD-2** — "Of those, which ones let me sleep in C overnight?"
3. **JTBD-3** — "Tell me what it really costs — both tickets, both bags, the hotel — and
   whether that beats just buying the nonstop."
4. **JTBD-4** — "Tell me why this will go wrong: bag recheck, immigration, terminal change,
   no visa, airport closed at 02:00, leg 2 is the last flight of the day."
5. **JTBD-5** — "Take me to where I can book each leg."

JTBD-4 is the differentiator. Anyone can concatenate two flights. The value is refusing to
show the ones that don't work.

---

## 4. The central constraint: data access

Everything below is downstream of one question — *where do real flight times come from?*

It is easy to build a **route graph** — the set of city pairs an airline publishes — from
free or cheap sources, and easy to fabricate plausible-looking departure times on top of it.
That produces a convincing demo that cannot answer JTBD-2 at all, because an invented
layover cannot be overnight in any meaningful sense. **Real, dated schedules with real local
times are the entire ask of this app.** Any plan that defers them defers the product.

The second finding: the two use cases do not share a data source. Frontier's published
network is US domestic plus the Caribbean and Central America — roughly 90 airports, none in
Asia or Europe. **UC-2 (Seattle → Japan → Seoul) cannot be served by a Frontier-shaped data
source at all.** Treat UC-1 and UC-2 as two data pipelines behind one search interface, and
make the routing engine source-agnostic so a new feed is a plug-in, not a rewrite.

Full sourcing analysis in [`03-data-sources.md`](./03-data-sources.md).

### 4.1 The search fan-out problem

A connection search is not one query, it is `2 × N` queries where N is the number of
candidate gateways. For a global origin/destination pair, N can be 40+. That is 80 upstream
calls per user search, which blows through rate limits and — with a per-search-priced
vendor — costs real money on a query that may return nothing.

Mitigation, which must be in the architecture from day one:

1. **Cheap pass:** filter candidate gateways from a cached route graph (free, no API calls).
   Ranks C by whether A → C and C → B both exist at all.
2. **Schedule pass:** fetch cached schedules for the surviving ~10 gateways, compute layovers
   and overnight classification. Schedules change slowly — cache for days.
3. **Price pass:** live-price only the top ~5 candidates the user actually looks at.
   Fares change constantly — cache for minutes, and expire quotes visibly.

---

## 5. Functional requirements

### 5.1 Search input

- **FR-1** Origin and destination, as airport code **or metro code** (SEL should mean both
  ICN and GMP; TYO should mean both NRT and HND).
- **FR-2** Departure date, plus a flexibility window (± N days). Overnight routings are
  frequently only possible on specific weekdays, so date flexibility is not optional.
- **FR-3** Return date, optional. v1 may treat each direction independently.
- **FR-4** Passengers (adults only in v1). Bag count per passenger — this materially changes
  the true price of a self-transfer, since bags are paid twice.
- **FR-5** Passport nationality. Required to evaluate visa/entry rules at the gateway; a
  routing that is fine for one passport is illegal for another.

### 5.2 Search preferences

- **FR-6** Connection style: `any` / `long layover only` / `overnight only` / `stopover`.
- **FR-7** Minimum and maximum layover, with defaults derived from §5.3 rather than a flat 45m.
- **FR-8** Number of overnight nights allowed (0, 1, 2+).
- **FR-9** Preferred / excluded gateway cities. "I'd happily overnight in Tokyo, never in LAX."
- **FR-10** Carrier allow/deny list; LCC-only toggle (for the GoWild case).
- **FR-11** Maximum legs — 2 in v1. Three-leg self-transfers exist but risk compounds badly.

### 5.3 Feasibility engine — the core

For each candidate `A → C → B`, compute and **hard-filter** on:

- **FR-12 Layover in UTC.** Never subtract local clock times. Convert both to UTC using the
  IANA timezone of each airport at that date, so DST transitions are handled.
- **FR-13 Self-transfer minimum connect time.** The airline's published MCT is irrelevant
  here — it assumes bags are through-checked and the airline holds the plane. Model our own,
  as a lookup on `(gateway, arrival_type, departure_type, has_checked_bag)`:

  | Arrival → Departure | No checked bag | With checked bag |
  |---|---|---|
  | Domestic → Domestic, same terminal | 90 min | 120 min |
  | Domestic → Domestic, terminal change | 120 min | 150 min |
  | International → International, same airport | 180 min | 240 min |
  | International → Domestic (clear immigration + customs) | 210 min | 270 min |
  | Different airport in same metro | 180 min + ground transfer time | 240 min + transfer |

  These are opening defaults to be tuned per airport, not gospel. Overnight connections
  clear this trivially — the table matters for the long-layover case and for rejecting a
  gateway where the *only* pairing is too tight.

- **FR-14 Airport curfew and overnight closure.** Some airports physically close, or ban
  night movements (NRT has a 00:00–06:00 curfew; ITM closes ~21:00). A leg 2 departure that
  the source shows at 05:30 from a terminal that opens at 04:30 is fine; one where the user
  would be locked landside from 01:00 is not.
- **FR-15 Same-metro-different-airport transfer.** Arriving NRT and departing HND is ~2h and
  a real cost. Must be surfaced as a distinct step, never hidden inside "layover".
- **FR-16 Entry/visa evaluation.** An overnight layover means the user *leaves the airside
  transit area and enters the country*. Transit-without-visa provisions do not apply. For
  `(passport_country, gateway_country)` the app must resolve one of:
  `visa_free` / `eta_required` (K-ETA, ESTA, ETIAS, eTA) / `visa_required` / `not_permitted`,
  and refuse or loudly flag anything that is not clean. This is a legal-consequence field,
  so it must cite its source and date, and always defer to the official government source.
- **FR-17 Bag recheck.** On separate tickets bags are essentially never through-checked.
  Assume recheck; state it; add it to time and cost.
- **FR-18 Day-of-week validity across midnight.** If leg 1 arrives Tuesday 23:40 and leg 2
  operates Mon/Wed/Fri, leg 2 departs *Wednesday* and is valid. Off-by-one on the operating-
  day bitmap after a midnight crossing is the most likely correctness bug in this app.

### 5.4 Cost model

- **FR-19** True cost = leg 1 fare + leg 2 fare + checked bag fees **per leg** + seat fees
  + hotel night(s) + airport ↔ hotel ground transfer + any ETA/visa fee, in one currency.
- **FR-20 Baseline comparison.** Show the cheapest published *through* itinerary A → B on
  the same dates alongside it. **Without this the app cannot make its core claim.** A
  self-transfer that saves $40 and adds 14 hours and all the risk is a bad deal, and the app
  should be willing to say so.
- **FR-21** For the GoWild case, model the pass economics separately: the segments may be
  ~$0 marginal, so bag fees, seat fees and the Early Booking Charge dominate.

### 5.5 GoWild-specific rules (UC-1)

This deserves its own section because a rule discovered during research **breaks the naive
version of the product**:

> GoWild flights can be booked and confirmed **the day before departure for domestic**
> travel, and **10 days before departure for international**. Booking earlier requires an
> Early Booking Charge of roughly $29–$89 per segment.

Consequences:

- **FR-22** You cannot confirm both legs of an overnight GoWild self-connection in advance
  at the base price. Leg 2 is *typically* not bookable until leg 1 is already in the air or
  has landed. The app must model this explicitly as a **sequential booking risk**, show the
  earliest confirmable datetime for each leg, and show the Early Booking Charge as the price
  of removing that risk.
- **FR-23** GoWild inventory is capacity-controlled and not exposed by any public API. The
  app can show that a *route and schedule* exist; it cannot promise a GoWild seat exists.
  Every GoWild result must say so.
- **FR-24** Model blackout dates and the pass's own validity window.

### 5.6 Results and output

- **FR-25** Rank by a user-chosen key: total price, total elapsed time, risk score, or
  layover-city desirability.
- **FR-26** Every itinerary shows a **risk disclosure block**: separate tickets, no
  protection, what happens if leg 1 is late, what a rebooking would cost.
- **FR-27** Risk score inputs: leg 1 historical on-time/cancellation rate, layover slack
  above the FR-13 minimum, whether leg 2 is the last departure of the day on that route,
  and how many alternative later flights exist as a fallback.
- **FR-28** Deep links to book each leg independently, carrying origin/destination/date.
- **FR-29** Provenance on every screen: which source, and when it was last refreshed.
- **FR-30** Explicit empty state explaining *why* nothing was found — no gateway, gateway
  found but no legal connection time, found but visa-blocked. "No results" alone is useless.

---

## 6. Non-functional requirements

- **NFR-1 Correctness of time is the top quality bar.** Store every instant as UTC plus the
  originating IANA zone. Never store a bare local time. Never store a fixed UTC offset.
  The `+1 day` arrival indicator must be derived, not trusted from a feed.
- **NFR-2 Latency.** First results (schedule-only, no prices) < 3s. Priced results may
  stream in behind that.
- **NFR-3 Cost ceiling.** Upstream API spend must be bounded per search; see §4.1. A search
  that returns zero results must be nearly free.
- **NFR-4 Caching.** Reference data: months. Route graph: weeks. Schedules: days. Fares:
  minutes, with a visible expiry. Cache TTL must be configurable per source because some
  licenses restrict caching duration.
- **NFR-5 Graceful degradation.** If the fare source is down, still show routings and times.
  If the schedule source is down, still show the route graph. Never a blank page.
- **NFR-6 Offline-capable reference data.** Airport, timezone, and route-graph data change
  slowly and should be bundled at build time, so the app is useful with no network and so a
  native/mobile build has no cold-start dependency.
- **NFR-7 Privacy.** Passport nationality (FR-5) is personal data collected only to evaluate
  visa rules. Keep it client-side, never log it, never send it to a third party.
- **NFR-8 Accessibility.** Keyboard navigable, screen-reader labelled, WCAG AA contrast.
- **NFR-9 Mobile first.** This gets used standing in an airport.

---

## 7. Legal and compliance

- **LC-1** Scraping airline websites for schedules violates most airlines' terms of use,
  including Frontier's. A once-in-a-while, manually-triggered read of a public sitemap or
  route index — a page published for crawlers — is defensible. **Scraping on every user
  search is not, and must not be built.** If the route graph comes from a scrape, it is a
  build-time artifact refreshed by hand, never a runtime dependency.
- **LC-2** Licensed schedule data (OAG, Cirium) carries redistribution, caching-duration and
  display restrictions. Read the license before designing the cache.
- **LC-3** No hidden-city ticketing, ever (§1.2).
- **LC-4** Affiliate or deeplink programs have their own display and attribution rules.
- **LC-5** Every result carries the disclaimer that these are separate tickets with no
  missed-connection protection, and that visa/entry information is advisory and must be
  confirmed with the relevant government.
- **LC-6** Personal-use tool vs. public app changes all of the above significantly. This is
  open question OQ-5.

---

## 8. Phasing

| Phase | Delivers | Data needed | Answers |
|---|---|---|---|
| **P0** | This document | — | What are we building |
| **P1** | Route-graph explorer | Airports + directional route pairs (free) | "Which cities C connect A to B at all?" |
| **P2** | Real schedules + overnight detection | Global schedule feed with local times + timezones | "Which of those can I sleep over in, on my date?" ← **the actual product** |
| **P3** | True cost + baseline comparison | Fare/offer source, bag fees, hotel rates | "Does this actually save me money?" |
| **P4** | Risk and legality | OTP history, visa matrix, curfews, MCT table | "Will this work, and am I allowed?" |
| **P5** | Booking handoff, saved trips, alerts | Deeplinks, affiliate | "Let me actually go" |

**P2 is the minimum viable product**, and under D-1/D-2/D-3 it is also the whole of v1.
P1 on its own is a route-graph browser, not a connection finder — it cannot tell an overnight
from a 40-minute sprint — and §9.1 folds it into P2 anyway.

---

## 9. Decisions

Settled 2026-09-05. These resolve most of the original open questions and constrain §8.

| # | Decision | Consequence |
|---|---|---|
| **D-1** | **Global / international first.** Build for UC-2 (Seattle → Japan → Seoul); UC-1 follows behind the same engine | Needs a global schedule feed. Frontier-shaped data is insufficient. The routing engine stays source-agnostic regardless |
| **D-2** | **Routings and times only in v1. No prices.** | FR-19/FR-20 (cost model, through-fare baseline) move out of MVP to P3. Removes the most expensive and most legally fraught dependency. The novel part — "can I overnight in Tokyo on my dates?" — survives intact |
| **D-3** | **$0 data budget. Free tiers only.** | Drives §9.1 below. This is the binding constraint, not D-1 |
| **D-4** | **Personal tool now, public later.** | Lighter disclaimers acceptable *for now*, but no architecture that only works under a personal-use exemption, and no data source whose license forbids later redistribution. Keep the licensing exit open |

### 9.1 The tension D-1 and D-3 create — and how it resolves

Global schedule coverage at zero cost is the hardest corner of the matrix. Free tiers are
metered in requests per month, and the naive search shape (§4.1) burns 2×N requests per user
search. At a free tier's quota that supports roughly a handful of searches per month. Unusable.

**The fix is a change of query shape, and it should be locked in before any code:**

> **Query by airport-day, not by origin–destination pair.**

Instead of asking a vendor "price A → C on date D" once per candidate gateway, ask
"give me the **departure board for airport A on date D**" — one request returning every
flight leaving A that day, with times and destinations. Then fetch the departure board for
each candidate gateway C on date D or D+1.

Why this changes the economics:

- **Requests collapse.** A search becomes `1 + (number of gateways actually examined)`
  requests, not `2 × N`. Most vendors' airport-schedule endpoints cost the same as a
  point-to-point query.
- **Cache hit rate becomes enormous.** A departure board for NRT on 2026-11-14 is identical
  for every user and every origin/destination pair. Under D-4 (personal tool) the cache is
  effectively permanent for near-dated queries. Cache by `(airport, date)` and a free tier
  goes a long way.
- **It matches what the engine actually needs.** The connection-building logic wants "what
  leaves A that day" and "what leaves C the next morning" — which *is* a departure board.
  The point-to-point search shape was always a worse fit for this problem.
- **It makes gateway discovery free.** Board for A on day D *is* the candidate gateway list.
  No separate route-graph source needed.

The cost is a fatter local pipeline: boards must be stored, indexed by airport-day, and
joined locally. That is cheap work and entirely under our control, and it is what makes
NFR-6 (bundled/offline reference data) natural rather than bolted on.

**Consequence for §8:** P1 (route-graph explorer) is largely absorbed into P2, since the
departure boards yield the graph for free. Go more or less straight to P2.

### 9.2 Still open

- **OQ-A — Wording check.** The brief says "overnight layovers in cities of their origin."
  This document reads that as *intermediate* cities en route, per the Seattle → Tokyo → Seoul
  example. Confirm that is the intent.
- **OQ-B — Ranking under D-2.** With no prices, what sorts the results? Total elapsed time,
  layover length, gateway desirability, or fewest-risk? Probably needs to be user-selectable,
  but the default matters.
- **OQ-C — Date flexibility depth.** FR-2's ± N days multiplies airport-day fetches linearly.
  Under D-3, what is N? Suggest ± 3 to start.
- **OQ-D — Platform.** Web only, or web plus a native/mobile build? The bundled-data approach
  (NFR-6) needs deciding early if mobile is in scope.
- **OQ-E — Round trips.** Independent one-ways in v1, or true round-trip optimization?

## 10. Success criteria

**v1 (under D-2, no prices).** For `SEA → ICN, departing in 3 weeks, 1 checked bag, US
passport, overnight allowed`, the app returns a routing via a Japanese or Taiwanese gateway
with **real** scheduled times from a real schedule feed, states the layover in hours and how
many nights, correctly handles the date-line and DST crossing, warns about bag recheck and
immigration, flags whether NRT/HND-style airport changes are involved, notes the passport is
fine for entry, and deep-links the user out to book each leg — and the trip actually works.

**Later (P3).** The same result also prices both legs plus a hotel and shows that total next
to the cheapest published nonstop, so the user can see whether it was worth it.
