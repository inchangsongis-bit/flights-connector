# Data Model — every data point the app needs

Companion to [`01-requirements.md`](./01-requirements.md). v0.2, rewritten for the
**single-ticket** pivot (D-5).

**Legend** — `REQ` required for the P1 MVP · `P2`/`P3`/`P4` needed at that phase ·
`OPT` nice to have · `DERIVED` computed by us, never stored from a feed.

---

## 0. Cross-cutting rules

1. **Every instant is stored as UTC + the IANA timezone it occurred in.** Never a bare local
   time. Never a fixed UTC offset — `+09:00` is a fact about one moment, not about a place.
   Local display is rendered from UTC + zone at read time.
2. **All time arithmetic happens in UTC.** Layover, elapsed journey, day offsets. Subtracting
   local clock times breaks across DST and the date line, and Seattle → Tokyo → Seoul crosses
   both.
3. **Every record carries provenance** — `source_id`, `fetched_at`, `valid_until`.

---

## 1. Itinerary offer — what the vendor returns

The core object. Under D-5 this arrives **whole** from the vendor: one ticket, all segments,
one price. We no longer assemble it ourselves.

| Field | Need | Why |
|---|---|---|
| `offer_id` | REQ | Vendor handle for repricing / deep link |
| `segments[]` | REQ | Ordered. See §2 |
| `total_price`, `currency` | REQ | Comes free with the itinerary — see D-2 |
| `fare_brand`, `is_basic_economy` | P3 | Predicts bag and change rules |
| `included_checked_bags` | P3 | One ticket ⇒ charged once |
| `validating_carrier` | REQ | **Whose stopover-program and bag rules apply** (§4, §5) |
| `booking_deeplink` | REQ | FR-29 |
| `quoted_at`, `expires_at` | REQ | Never show a stale price as current |
| `is_multi_city` | P2 | Mode B offers |

**Deliberately not modelled:** anything about combining separate bookings. Self-transfer MCT,
double bag fees, missed-connection cost, sequential booking — all removed by D-5. If OQ-B
revives self-transfer as Mode C, they come back as a separate module, not by loosening this one.

---

## 2. Segment

One flight within an itinerary.

| Field | Need | Why |
|---|---|---|
| `marketing_carrier` + `flight_number` | REQ | Identity |
| `operating_carrier` | REQ | Owns the terminal, the bag rules and the on-time record |
| `origin`, `destination` | REQ | |
| `departure_local` + `departure_timezone` | REQ | As published |
| `departure_utc` | DERIVED | All arithmetic uses this |
| `arrival_local` + `arrival_timezone` + `arrival_utc` | REQ / DERIVED | |
| `arrival_day_offset` | DERIVED | `+1`/`+2`. **Compute it; never trust a feed's flag** |
| `block_minutes` | DERIVED | `arrival_utc − departure_utc` |
| `departure_terminal`, `arrival_terminal` | P3 | Terminal change during a layover |
| `aircraft_type` | OPT | Matters on a long-haul leg |
| `stops` | REQ | A "direct" flight with a technical stop is not a nonstop — flag it |
| `cabin` | P3 | Stopover-program eligibility is often cabin-dependent |

---

## 3. Airport

Slow-changing reference data. Bundle at build time.

| Field | Need | Why |
|---|---|---|
| `iata_code` | REQ | User-facing identity |
| `icao_code` | OPT | Feed joins |
| `name`, `city_name` | REQ | Display |
| `metro_code` | REQ | TYO/OSA/SEL/NYC/LON grouping (§6) |
| `country_code` (ISO-3166) | REQ | Drives visa evaluation (§8) |
| `latitude`, `longitude` | REQ | Map, distance sanity checks |
| **`timezone` (IANA)** | **REQ** | The most important field in the app. `Asia/Tokyo`, not `+9` |
| `type`, `is_active` | REQ | Filter out heliports and closed fields |
| `curfew_start`, `curfew_end` | P3 | NRT 00:00–06:00, ITM ~21:00 (FR-18) |
| `landside_open_24h` | P3 | Can the traveller sit in the terminal, or are they locked out |
| `immigration_p50_min` | P4 | Eats into usable city hours |
| `to_city_center_minutes`, `to_city_center_cost` | P4 | **Feeds usable-hours scoring (FR-16)** — a 14h layover 90 min from the city is a 11h layover |
| `sleep_friendly_score` (0–5) | OPT | Whether staying in the terminal is survivable |

**Source note:** OurAirports (public domain) covers everything down to `type`. It has **no
timezone column** — that requires a lat/lon → tz shapefile join. Easy, mandatory, easy to
forget. Curfews and city-transfer times exist in no free dataset; hand-curate for the ~30
airports we actually route through.

---

## 4. Airline

| Field | Need | Why |
|---|---|---|
| `iata_code`, `name` | REQ | |
| `alliance` | P3 | Explains which stopover routings are constructible |
| **`max_through_check_hours`** | **P3** | **The surviving footgun (FR-19).** AA ~12h (≈16.5h on AA/partner), UA ~12h, DL generally through-checks on one ticket, many non-US ~24h. Varies by carrier *and* airport — ⚠️ verify, and store `unknown` honestly |
| `checked_bag_fee` | P3 | Charged once now, not twice |
| `otp_rate` | P4 | Minor under D-5 — the airline rebooks you — but still nice signal |
| `booking_deeplink_template` | REQ | |

---

## 5. Stopover program — new in v0.2, high value

Small hand-curated table, ~20 rows, disproportionately decision-relevant (FR-24 to FR-26).
Can flip a routing from "costs a hotel night" to "includes one".

| Field | Need | Why |
|---|---|---|
| `carrier` | P3 | |
| `program_name` | P3 | "Dubai Connect", "Touristanbul", ANA Multiple Stopover Service |
| `free_stopovers_per_direction` | P3 | ANA/JAL: 1 free |
| `additional_stopover_cost` | P3 | ANA/JAL: ~$130 |
| `eligible_cities[]` | P3 | ANA/JAL: 40+ Japanese destinations |
| `free_hotel_min_layover_hours` | P3 | Turkish ≥ 20h; Emirates *Dubai Connect* on long layovers where no shorter connection exists |
| `free_hotel_cabin_rules` | P3 | Turkish: 1 night economy, up to 3 business ex-US |
| `city_tour_offered`, `tour_layover_hours` | OPT | Touristanbul: 6–24h |
| `booking_method` | P3 | Several require phone booking or a specific fare class — the difference between a real option and a tease |
| `source_url`, `checked_at` | REQ | ⚠️ Terms change often and vary by fare. Cite and date (LC-4) |

Known carriers to seed: ANA, JAL, Turkish, Emirates, Qatar, Ethiopian, Saudia, Gulf Air.

---

## 6. Metro / city group

| Field | Need | Why |
|---|---|---|
| `metro_code`, `member_airports[]` | REQ | "Tokyo" must mean NRT **and** HND |
| `transfer_matrix[from][to]` | P3 | NRT → HND is ~2h. Rare on one ticket but real, and never to be hidden inside "layover" (FR-17) |

~30 hand-written rows. The Seattle → Tokyo → Seoul case runs straight through it.

---

## 7. Visa / entry

Keyed `(passport_country, layover_country)`. An overnight layover means **entering the
country**, so transit-without-visa does not help.

| Field | Need | Why |
|---|---|---|
| `status` | P3 | `visa_free` / `eta_required` / `visa_required` / `not_permitted` |
| `eta_scheme`, `eta_cost`, `eta_lead_time_days` | P3 | K-ETA, ESTA, ETIAS, eTA. Lead time answers "can I even do this by my date" |
| `max_stay_days` | OPT | |
| `airside_transit_ok` | P3 | If the layover is short enough to stay airside, the question may not arise (FR-23) |
| `source_url`, `checked_at` | REQ | Legal-consequence data — cite, date, defer to government (LC-5) |

---

## 8. Cost inputs

| Field | Need | Why |
|---|---|---|
| `hotel_nightly_rate(city, date)` | P4 | Unless the stopover program supplies one (§5) — then it is a **negative** cost |
| `airport_hotel_transfer_cost` | P4 | |
| `fx_rates` | P4 | One display currency |

---

## 9. Derived itinerary view

What the engine emits. Nothing here comes from a feed.

```
LayoverItinerary
  offer                       → ItineraryOffer (§1)
  layover_airport             → iata
  layover_metro               → iata   (differs ⇒ airport change, FR-17)
  layover_minutes             DERIVED  seg2.departure_utc − seg1.arrival_utc
  layover_class               DERIVED  short | long | overnight | stopover   (§2.1)
  nights_required             DERIVED  local calendar dates spanned
  usable_city_hours           DERIVED  layover minus immigration, minus round-trip city
                                       transfer, minus local 23:00–07:00 — the number that
                                       decides whether this is a night in Tokyo or a night
                                       in a terminal (FR-16)
  arrival_day_offset          DERIVED
  total_elapsed_minutes       DERIVED  last arrival_utc − first departure_utc
  bag_through_checked         DERIVED  layover_hours ≤ carrier.max_through_check_hours
                                       → true | false | unknown   (FR-19/FR-20)
  stopover_program            DERIVED  matched §5 row for validating_carrier + city
  free_hotel_eligible         DERIVED  from that row + layover hours + cabin
  entry_status                DERIVED  §7 lookup for the traveller's passport
  required_actions[]          DERIVED  clear_immigration | recheck_bag | change_terminal
                                       | change_airport | overnight_stay
  blockers[]                  DERIVED  visa_required | airport_closed_overnight
                                       | unusable_hours    → powers the honest empty state
  layover_score               DERIVED  FR-15 ranking: usable hours, city desirability,
                                       stopover-program bonus, band fit
  net_cost                    P4       fare + hotel − free hotel + transfers
  vs_fastest                  P4       Δ time and Δ price against the fastest normal
                                       itinerary — the FR-28 sentence
```

---

## 10. Not modelled

- Self-transfer / separate tickets (removed by D-5; see OQ-B before deleting the hooks).
- Hidden-city ticketing — no fields, no support, ever.
- Loyalty accrual, award pricing, upgrades.
- Seat maps, meals, ancillaries beyond bags.
- 3+ stop itineraries in v1.
- Ground transport as a segment.

---

## 11. Highest-risk data gaps

Ranked by how badly it hurts to get wrong:

1. **A vendor that will actually return long-layover itineraries.** If its engine applies its
   own max-connect-time and drops them, no amount of local filtering helps and the product
   cannot exist on that vendor. **Test this first** — see
   [`03-data-sources.md`](./03-data-sources.md).
2. **Timezone correctness (§0).** Free to get right, catastrophic to get wrong, invisible in
   testing until someone crosses the date line.
3. **`max_through_check_hours` (§4).** The one real footgun that survived the pivot. No free
   source; hand-curate and mark unknowns honestly rather than guessing.
4. **Stopover-program terms (§5).** Highest value-per-row in the whole model, and the most
   volatile. Must be cited and dated.
5. **Usable-hours scoring (§9).** Needs airport↔city transfer times (§3). Without it the app
   recommends a "night in Tokyo" that is really a night at the gate.
6. **Visa/entry (§7).** Small dataset, legal consequences.
