# Stopover programs

`stopover-programs.json` — 19 carriers, hand-curated. Validate with
`node scripts/validate-data.mjs`.

This is the highest value-per-row data in the project. It's what lets a result say *"ANA's
first stopover in Japan is free"* instead of just *"16h layover"* — and it needs no API, no
key, and nobody's permission.

## Four mechanisms, routinely conflated

Every "free stopover" listicle mashes these together. They behave completely differently and
the app must not blur them.

| Mechanism | What it is | Who chooses |
|---|---|---|
| **`fare_stopover`** | The fare permits a break in journey at the hub, free or for a fee, booked as multi-city | **You.** This is the mechanism the app constructs against |
| **`carrier_provided_hotel`** (STPC) | The airline supplies a hotel because the connection is long | **The schedule.** Usually not something you can opt into — see the trap below |
| **`paid_stopover_package`** | A discounted hotel/tour bundle sold as an add-on | You, for money |
| **`transit_tour`** | A free city tour for qualifying transit passengers | You, if the layover fits |

## The trap: free hotels usually require that you had no choice

**Emirates' Dubai Connect applies only where no shorter connection is available.** So a
passenger who *deliberately picks* a long layover normally **disqualifies themselves** from the
free hotel.

That's the exact inverse of what this app does. Telling someone "Emirates gives you a free
hotel" when they chose an 18-hour layover on purpose would be actively wrong and would cost
them a hotel night they hadn't budgeted for.

Hence `requires_no_shorter_connection`, and hence the validator **hard-errors** if a carrier
offers a hotel but that field is unset. Emirates is `true`. Most others are `"unknown"` —
which must display as "may not apply to a chosen stopover; confirm with the carrier", never as
a promise.

## Revenue fares vs award tickets

Korean Air's SkyPass eliminated free stopovers — **on award tickets**. That says nothing about
revenue fare rules, and the two get conflated constantly. This app deals in revenue fares.
`KE.fare_stopover.available` is `"unknown"` for exactly that reason, not because the SkyPass
change applies.

## Confidence and the honesty rules

Most rows come from travel-industry secondary sources, not carrier pages. Terms change often
and vary by fare, cabin and point of sale.

`validate-data.mjs` enforces (per requirements LC-4 / FR-32):

- every row cites at least one source, each with an ISO `checked_at` date
- `confidence` is one of `high` / `medium` / `low`
- `verify_before_display` is `true` on every row — nothing here is a guarantee
- any carrier-provided hotel declares `requires_no_shorter_connection`
- `available` is a tri-state (`true` / `false` / `"unknown"` / `"unofficial"`), never a
  silently-missing field

Current spread: **2 high, 8 medium, 9 low.** The low-confidence rows are honest placeholders
marking what to verify, not claims.

## Coverage for the motivating case

Seven carriers are marked `relevant_to_motivating_case` for Seattle → Asia → Seoul:

| Carrier | Hub | Why it matters |
|---|---|---|
| **ANA (NH)** | HND/NRT | **First stopover in Japan free per direction**, second ~$130, 40+ Japanese cities. The strongest match |
| **JAL (JL)** | HND/NRT | Mirrors ANA — free first stopover, second ~$130 |
| **Korean Air (KE)** | ICN | STPC hotel on select routes, but requires an email request ≥1 day ahead — not automatic |
| **Asiana (OZ)** | ICN | Hotel + 2 meals + transfer on certain **US-origin** itineraries under 24h. Free Incheon tours 4–24h |
| **Cathay (CX)** | HKG | Free Hong Kong stopover up to 7 days from North America |
| **China Airlines (CI)** | TPE | Free stopover up to 90 days; €50 in some booking classes |
| **EVA Air (BR)** | TPE | **No published programme** — but multi-city pricing is often at or below the connecting fare, so it's effectively free in practice. Marked `"unofficial"`. Worth surfacing precisely because no listicle covers it |

## Adding a carrier

Copy an existing block, fill what you can verify, leave the rest `"unknown"`, set
`confidence` honestly, cite your source with today's date, keep `verify_before_display: true`.
Then run the validator.

Guessing a value is worse than leaving it `"unknown"` — an unknown shows as "confirm with the
carrier", which is always safe. A wrong value strands someone without a hotel.
