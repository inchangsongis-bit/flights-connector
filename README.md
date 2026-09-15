# Layover Finder

Find **one-ticket** flight itineraries that happen to have a long or overnight layover
somewhere worth stopping.

`SEA → NRT → ICN` with 16 hours on the ground in Tokyo is a real itinerary that a real
airline will really sell you. One booking, bags handled, and if the first flight is late they
rebook you. You just can't *find* it — every search engine sorts by shortest total duration,
so a 16-hour layover ranks below every nonstop and gets buried or filtered out entirely.

This app inverts that sort. **The layover is the point, not the penalty.**

## Not to be confused with

- **Self-transfer** — booking two separate tickets and connecting yourself. Different, riskier
  product. Out of scope.
- **Hidden-city ticketing** — booking past your destination and walking out. Violates every
  contract of carriage. Permanently out of scope.

## Status

**Planning.** No implementation yet. Requirements defined before any design work.

## Documents

| | |
|---|---|
| [`docs/01-requirements.md`](docs/01-requirements.md) | Problem, search modes, functional & non-functional requirements, legal constraints, phasing, open questions |
| [`docs/02-data-model.md`](docs/02-data-model.md) | Every data point needed, entity by entity, with phase markers |
| [`docs/03-data-sources.md`](docs/03-data-sources.md) | Vendor evaluation, the one test that matters, recommended path |

## How it works without paid flight data

No free source of *sold itineraries* exists — Amadeus is gated, Duffel needs a funded account,
Kiwi is invite-only, Travelpayouts' search API requires 50k monthly users. That blocks
discovering long layovers hidden inside published connections.

**But the main use case doesn't need one.** A requested multi-city stopover — `SEA → HND` day 1,
`HND → ICN` day 2 — is *not* a connection. The airline's maximum connect time applies to
connections its engine builds, not to two origin-destinations you explicitly asked for. It sells
that as one ticket by design; it's how ANA and JAL free-stopover fares are booked.

So candidates can be assembled from plain schedule data: check both flights actually operate on
those dates, check one carrier can ticket both, then hand off to the carrier's own multi-city
search for price and availability. We verify a candidate is *operationally real* — the flights
fly, the times are right, the carrier can ticket it. The airline confirms the rest, and every
result says so.

## The short version

**Airlines already want to sell this.** ANA and JAL both give you a **free first stopover in
Japan** per direction (second ~$130, across 40+ Japanese cities). Turkish gives you a **free
hotel in Istanbul** on layovers of 20h+, and a free city tour on 6–24h. Emirates, Qatar,
Ethiopian, Saudia and Gulf Air run similar programmes. None of it is discoverable through
normal flight search, and knowing which carrier's stopover is free can flip a routing from
costing a hotel night to including one.

**Two search modes:**
- **Construct** *(the MVP)* — "Seattle to Seoul, one night in Tokyo." Assembled from free
  schedule data; see above.
- **Discover** *(deferred)* — normal `A → B` search re-ranked by layover quality, surfacing long
  layovers in cities you hadn't thought of. Better UX, needs an itinerary API we can't reach yet.

**Three things that are easy to get wrong:**
1. **Timezones.** Seattle → Tokyo → Seoul crosses the date line and, seasonally, a DST
   boundary. Every layover is computed in UTC from IANA zones, never from local clock times.
2. **Usable hours ≠ layover hours.** 14 hours arriving 01:00 is not a night in Tokyo, it's a
   night in a terminal. Subtract immigration, the round trip to the city, and the hours you'd
   be asleep.
3. **Bags aren't always through-checked.** On one ticket they usually are — but carriers cap
   it, often lower than people expect (American ~12h, United ~12h, many non-US ~24h). Long
   layovers can cross that line.

Open questions are in [§10 of the requirements](docs/01-requirements.md#10-open-questions).

## Implementation status

Planning is done; the engine is built and tested. The only remaining dependency for a working
P1 is a live schedule feed, which is gated on the P0 probe.

| | State |
|---|---|
| Requirements, data model, sourcing | Done — `docs/` |
| Stopover programme table (19 carriers) | Done — `data/stopover-programs.json`, validated |
| Airport + timezone reference (5,515 airports) | Done — `data/airports.json` |
| Route graph (35,983 directional pairs) | Done — `data/routes.json` |
| Gateway discovery, detour filtering | Done — `src/engine/gateways.mjs` |
| Layover classification, usable-hours scoring | Done — `src/engine/layover.mjs` |
| Ticketability, stopover matching | Done — `src/engine/{ticketability,stopover}.mjs` |
| Tests (32, incl. date-line and both DST directions) | Done — `npm test` |
| Entry / visa rules, date-aware | Done — `data/entry-rules.json`, `src/engine/entry.mjs` |
| UI — Layover Board | Done — `web/`, published |
| **Schedule source proven** | **✅ AeroDataBox reaches +90 days** (2026-09-15) |
| **Field mapping confirmed** | **✅** against a real 408-flight board (2026-09-15) |
| **Live search pipeline** | **✅ `npm run find`** — `src/engine/search.mjs` |
| Disk cache for quota | Done — `src/adapters/cache.mjs` |
| Live schedules in the web UI | Done — `npm run find -- … --json` |
| Baggage through-check rules | Done — `data/baggage-rules.json` |
| **Booking handoff** | **✅ verified** — one click opens both legs in Google Flights, priced as one ticket |

```bash
# live search — needs a free RapidAPI key for AeroDataBox
RAPIDAPI_KEY=... npm run find -- SEA ICN 2026-10-13
RAPIDAPI_KEY=... npm run find -- SEA ICN 2026-10-13 --passport=GB --same-carrier

npm test           # 89 tests, no network
npm run demo       # the pipeline on fixture schedules, no key needed
npm run check      # validate data + test
npm run build:data # refresh reference data from OpenFlights
npm run build:web  # regenerate web/ from src/engine and data/
```

### Quota

The free AeroDataBox tier is ~600 units/month and each call costs several, so cost control is
a design constraint rather than an optimisation. Four things:

1. **The offline route graph filters first.** A route it rules out costs **zero** calls.
2. **Only boards that can hold a qualifying flight are fetched.** A leg landing at 16:25 with an
   8-hour minimum cannot pair with anything until 00:25 the next day, so the arrival-day board
   is skipped entirely.
3. **A budget guard**, default 24 calls. The plan is only knowable after the origin board, so it
   stops with two calls spent rather than discovering the cost after twenty.
4. **Boards cache to disk** per `(airport, date, window)` — a SEA board is identical for every
   route through it, so repeat searches are free.

See the cost before paying it:

```bash
npm run find -- SEA ICN 2026-10-13 --dry-run
```

The layover band is the biggest lever: a 28-hour span crosses three daily boards, a 10-hour span
usually one or two. `--max=24` is meaningfully cheaper than the default `--max=36`.

The demo runs the real engine, the real route graph and the real curated data against
**invented** flight times. Swapping `getDeparturesFixture()` for a live
`getDepartures(airport, date)` is the entire remaining dependency for P1.
