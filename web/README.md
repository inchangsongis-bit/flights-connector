# web — Layover Board

Published: <https://claude.ai/artifact/Hh8MtrSJjgEU36kafMfVqx> (private)

A gateway explorer. Pick two airports; see which cities between them are reachable on **one
ticket**, ranked by ticketing confidence, then stopover programme, then how far out of the way
they take you.

It is useful *today*, without a schedule feed, because the question it answers — "which places
in between could I overnight in, and which airline would make that free?" — is answered entirely
by the route graph and the curated programme table.

## Files

| | |
|---|---|
| `index.html` | The page. Self-contained apart from `data.json` and Google Fonts |
| `data.json` | Generated bundle — 1,386 airports, 30,279 routes, 19 programmes, alliances |

Regenerate `data.json` after `npm run build:data`; the inline script in the repo root
`package.json` history shows the trim (airports appearing in ≥ 8 directional pairs).

## The centrepiece: the 24-hour dial

The slider is the reason the page exists. Drag it across the **24-hour line** and the verdict
flips from *Connection* to *Stopover*, and the entitlements change with it:

- **Under 24h** — an ordinary connection. No fare premium, and **no stopover programme applies**.
  The page says so rather than implying a benefit that isn't there.
- **Over 24h** — a stopover. Fare rules govern, and ANA's free first stopover (say) kicks in.

That boundary is an industry definition, not ours — ANA states it explicitly. It is the single
most load-bearing fact in the project, and it's the thing a static list of "airlines with free
stopovers" will never tell you.

## Engine parity

The page re-implements `src/engine/` in the browser: `classify`, `usableCityHours`,
`ticketability`, `findGateways`, `detour`, and the 24-hour boundary. Logic is deliberately kept
line-for-line comparable to the Node modules so the two cannot drift silently.

**If you change a rule in `src/engine/`, change it here too**, and re-run `npm test` — the Node
tests are the specification for both.

One browser-only wrinkle: `instantFor()` builds a UTC instant from a wall-clock time in a zone.
That direction is ambiguous across DST transitions, so it guesses, measures the drift, corrects,
and re-checks. The Node engine never needs it, because it receives instants from the schedule
feed rather than constructing them.

## What is honest about it

The page states its own limits in the colophon rather than burying them:

- flight times are **modelled, not real** — no schedule feed is wired up
- the route graph is ~2014 OpenFlights, used strictly as a candidate filter
- every stopover-programme row is a **lead to verify**, dated, never a promise
- an overnight means clearing immigration, so it says so
