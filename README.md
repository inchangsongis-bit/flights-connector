# Overnight Connector

Find flight routings that airlines won't sell you as one ticket — especially ones with an
**overnight layover** in an intermediate city.

Search engines only show connections the airline itself publishes and sells. Anything longer
than the carrier's maximum connect time gets dropped from results, which is exactly the
overnight stop we're looking for. Two separate tickets, `A → C` and `C → B`, are often
cheaper, sometimes the only option, and occasionally a free extra city.

**Two motivating cases:**

- Cheap US domestic hops on a budget network (Frontier GoWild) where no nonstop is published
  between the two cities you want.
- Long-haul with a deliberate night on the ground — Seattle → Tokyo, sleep, Tokyo → Seoul.

**What it is not:** hidden-city ticketing, a booking engine, or a promise. Two separate
tickets means no missed-connection protection, and the app's main job is being honest about
exactly what will go wrong.

## Status

**Planning.** No implementation yet. Requirements are being defined before any design work.

## Documents

| | |
|---|---|
| [`docs/01-requirements.md`](docs/01-requirements.md) | Problem, use cases, functional & non-functional requirements, legal constraints, phasing, open questions |
| [`docs/02-data-model.md`](docs/02-data-model.md) | Every data point needed, entity by entity, with MVP/phase markers |
| [`docs/03-data-sources.md`](docs/03-data-sources.md) | Where each data point comes from, vendor evaluation, recommended path |

## The short version

Three findings drive everything:

1. **Real dated schedules with local times and timezones are the whole project.** A route
   graph is easy and free; an overnight layover cannot be computed without real times.
   Sourcing that feed is the first decision — see `docs/03-data-sources.md`.
2. **The two use cases don't share a data source.** Frontier's network has no Asian or
   European airports. Build the engine source-agnostic.
3. **GoWild flights can only be confirmed the day before departure** (10 days for
   international). You largely cannot lock both legs of an overnight self-connection in
   advance without paying an early-booking charge — a structural constraint the product has
   to be designed around, not patched around later.

Open questions that need answers before design starts are in
[§9 of the requirements](docs/01-requirements.md#9-open-questions).
