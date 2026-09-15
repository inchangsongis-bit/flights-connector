# Entry rules

`entry-rules.json` — 14 countries, hand-curated. Evaluated by `src/engine/entry.mjs`.

An overnight layover means **leaving the transit area and entering the country**.
Transit-without-visa provisions do not apply. So the app has to answer a question with legal
consequences, where being wrong strands someone at a border.

## Entry rules are a function of the travel date

This is the finding that shaped the design, and it is not hypothetical — three live examples
sit inside an ordinary planning horizon:

| Scheme | Status |
|---|---|
| **Korea K-ETA** | Temporarily **waived** for 22 nationalities incl. US and Japan **through 2026-12-31**; mandatory again **from 2027-01-01** |
| **ETIAS** (Schengen) | Repeatedly delayed; the EU has removed its 2026 target. 2027 is realistic, with a six-month transition after launch during which it is not a boarding condition |
| **Japan JESTA** | Legislated for fiscal 2028, statutory deadline 2029-03-31. **Not required for 2026 or 2027 travel** |

A trip to Seoul in December 2026 needs no K-ETA. **The same trip three weeks later does.** A
static `status` field would have given the wrong answer to anyone planning across that boundary,
silently and confidently.

So rules carry `effective_from` / `effective_until` and are evaluated against the **layover
date**, never today's date. `upcomingChange()` additionally warns when a rule flips within 180
days of travel — the case where someone books in good faith and gets caught out.

## Rule ordering is enforced by the engine, not by the data

A bug worth recording, because the fix generalises.

Japan's `visa_free` rule carries no dates and was written above its JESTA rule. Under naive
first-match-wins, the open-ended rule matched every date and **permanently shadowed** the
future-dated one — the app would have said "visa-free" in 2029.

Hand-ordering is a footgun. The evaluator now checks **date-bounded rules before open-ended
ones**, so the outcome no longer depends on the order rules happen to be written in. Covered by
a named regression test.

## Hedging is deliberate

Anything not explicitly matched resolves to **`unknown`**, rendered as "check before you go" —
never silently to "fine".

> A false `unknown` costs a web search. A false `visa_free` costs a trip.

Every result carries `verifyBeforeTravel: true`, a confidence level, and its source with a date.

## Visa-free is not the whole answer

A third category that gets missed because the country is visa-free:

- **Singapore** — SG Arrival Card, mandatory, within 3 days of arrival, includes a health declaration
- **Taiwan** — TWAC digital arrival card

These are modelled as `arrival_formalities`, separate from visa status, and surface alongside it.

## Coverage and honesty

| | |
|---|---|
| Researched and sourced | JP, KR, SG, IS (+ PT, FI via Schengen) |
| Partial / conflicting sources | TW (visa-free certain; **duration disputed** — 90 days vs a 14-day trial) |
| Recorded but unverified | HK, AE |
| Known gaps, deliberately empty | QA, ET, SA, BH, PA |

The empty ones resolve to `unknown` rather than being guessed. **Doha and Dubai are major
stopover gateways**, so those are the highest-value rows to fill next.

Nationality coverage is a named-group system (`anglo`, `schengen`, `east_asia_developed`) plus
per-country additions. A passport outside those lists is `unknown`, not ineligible.

## Adding a country

Copy an existing block, list only what you can verify, leave the rest out, set `confidence`
honestly, cite a government source with today's date. Put date-bounded rules in — the engine
orders them correctly regardless of position. Then `npm test`.

Guessing is worse than `unknown`. An unknown sends someone to check; a wrong `visa_free` sends
them to an airport.
