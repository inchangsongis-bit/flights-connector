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

## The short version

**Airlines already want to sell this.** ANA and JAL both give you a **free first stopover in
Japan** per direction (second ~$130, across 40+ Japanese cities). Turkish gives you a **free
hotel in Istanbul** on layovers of 20h+, and a free city tour on 6–24h. Emirates, Qatar,
Ethiopian, Saudia and Gulf Air run similar programmes. None of it is discoverable through
normal flight search, and knowing which carrier's stopover is free can flip a routing from
costing a hotel night to including one.

**Two search modes:**
- **Discover** — normal `A → B` search, pulled wide and re-ranked by layover quality. Surfaces
  long layovers in cities you hadn't thought of. One API request. This is the MVP.
- **Construct** — "Seattle to Seoul, one night in Tokyo" as a multi-city single-ticket search,
  which is how stopovers are actually priced.

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
