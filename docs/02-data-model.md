# Data Model — every data point the app needs

Companion to [`01-requirements.md`](./01-requirements.md). This is the exhaustive inventory:
what we need, why we need it, and whether it is required for the MVP.

**Legend** — `REQ` required for MVP (P2) · `P3`/`P4` needed at that phase · `OPT` nice to have
· `DERIVED` computed by us, never stored from a feed.

---

## 0. Cross-cutting rules

Three rules that, if broken anywhere, break the whole app:

1. **Every instant is stored as UTC + the IANA timezone it happened in.** Never a bare local
   time. Never a fixed UTC offset (`+09:00` is a fact about one moment, not about a place).
   Local display is rendered from UTC + zone at read time.
2. **Every arithmetic operation on time happens in UTC.** Layover, elapsed journey, day
   offsets. Subtracting local clock times silently produces wrong answers across DST and
   across the date line — and both of those are on the Seattle → Tokyo → Seoul path.
3. **Every record carries provenance**: `source_id`, `fetched_at`, `valid_until`. The app
   must always be able to say where a number came from and how stale it is.

---

## 1. Airport

The foundational reference table. Slow-changing, bundle it at build time.

| Field | Type | Need | Why |
|---|---|---|---|
| `iata_code` | char(3) | REQ | User-facing identity, deeplinks |
| `icao_code` | char(4) | REQ | Join key for schedule and OTP feeds, which often prefer ICAO |
| `name` | text | REQ | Display |
| `city_name` | text | REQ | Display, gateway desirability |
| `metro_code` | char(3) | REQ | TYO/OSA/SEL/NYC/LON grouping — see §2 |
| `country_code` | char(2) ISO-3166 | REQ | Drives visa evaluation (FR-16) and domestic/international classification |
| `subdivision` | text | OPT | US state, for display |
| `latitude`, `longitude` | float | REQ | Map, great-circle distance, sanity-checking absurd routings |
| `timezone` | IANA string | **REQ** | The single most important field in the app. `Asia/Tokyo`, not `+9` |
| `type` | enum | REQ | Filter out heliports, seaplane bases, closed fields |
| `is_active` | bool | REQ | Closed airports still appear in open datasets |
| `terminals[]` | list | P4 | Terminal-change detection (FR-13) |
| `curfew_start`, `curfew_end` | local time | P4 | Night movement bans — NRT 00:00–06:00, ITM ~21:00 close (FR-14) |
| `landside_open_24h` | bool | P4 | Can the user physically sit in the terminal all night, or are they locked out |
| `has_airside_transit_area` | bool | P4 | Some airports force everyone through immigration regardless |
| `immigration_p50_min`, `immigration_p90_min` | int | P4 | Realistic clearance time, feeds the MCT table |
| `to_city_center_minutes`, `to_city_center_cost` | int | P4 | Overnight means going to a hotel |
| `sleep_friendly_score` | 0–5 | OPT | Whether an overnight *in* the terminal is survivable |

**Source note:** OurAirports is public-domain and covers code/name/city/country/lat/lon/type.
Timezone is *not* in it — that needs a separate join (tz lookup by coordinate, or a curated
table). Curfews, terminals and immigration times exist in no free dataset and will be hand-
curated for the ~30 gateways we actually care about.

---

## 2. Metro / city group

| Field | Type | Need | Why |
|---|---|---|---|
| `metro_code` | char(3) | REQ | TYO, OSA, SEL, NYC, WAS, LON, CHI, PAR, MIL |
| `member_airports[]` | list | REQ | Search expansion: "Tokyo" must mean NRT *and* HND |
| `transfer_matrix[from][to]` | {minutes, cost, mode} | P4 | NRT → HND is ~2h and ~¥3,000. A "layover in Tokyo" that lands NRT and leaves HND is a completely different trip and must never be presented as a plain connection (FR-15) |

This table is small, entirely hand-curated, and disproportionately valuable — the Seattle →
Tokyo → Seoul case runs straight through it.

---

## 3. Airline / carrier

| Field | Type | Need | Why |
|---|---|---|---|
| `iata_code` | char(2) | REQ | `F9`, `NH`, `KE` |
| `icao_code` | char(3) | OPT | Feed joins |
| `name` | text | REQ | Display |
| `is_lcc` | bool | REQ | LCC-only filter (FR-10); also predicts bag-fee behaviour |
| `alliance` | enum | OPT | Explains why a through-ticket does/doesn't exist |
| `interlines_with[]` | list | P4 | If two carriers *do* interline, a through ticket may exist and self-transfer is pointless |
| `checked_bag_fee` | by route/cabin/prepaid | P3 | Paid **twice** on separate tickets — often the whole "saving" |
| `carry_on_included` | bool | P3 | Frontier charges for carry-on; that changes the maths |
| `seat_fee_typical` | money | P3 | |
| `change_fee`, `is_refundable` | money/bool | P4 | What it costs when leg 1 is late and leg 2 is forfeit |
| `booking_deeplink_template` | url template | REQ | FR-28 handoff |
| `otp_rate`, `cancel_rate` | float | P4 | Risk score (FR-27). US carriers: DOT/BTS is free. Global: licensed |

---

## 4. Route (network edge)

The cheap pre-filter layer (§4.1 of requirements). One row per **directional** pair.

| Field | Type | Need | Why |
|---|---|---|---|
| `origin`, `destination` | iata | REQ | Directional — A→B existing does not imply B→A |
| `carrier` | iata(2) | REQ | Who flies it |
| `season_start`, `season_end` | date | REQ | Seasonal routes are the #1 cause of "this route exists" being wrong on the user's date |
| `days_of_week` | bitmap | REQ | 2–3× weekly routes are common and change everything about connectability |
| `typical_block_minutes` | int | OPT | Pre-filter sanity |
| `is_suspended` | bool | REQ | |
| `source_id`, `checked_at` | text/date | REQ | Provenance (FR-29) |

---

## 5. Scheduled flight — the layer that makes this a real product

Everything above exists in free data. **This layer is the one that must be bought or
licensed**, and it is the difference between a route-graph toy and an overnight-connection
finder.

| Field | Type | Need | Why |
|---|---|---|---|
| `marketing_carrier` + `flight_number` | | REQ | Identity |
| `operating_carrier` | iata(2) | REQ | Codeshares: the operating carrier owns the terminal, the bag rules and the OTP record |
| `origin`, `destination` | iata | REQ | |
| `departure_local` (date + time) | | REQ | As published |
| `departure_timezone` | IANA | REQ | |
| `departure_utc` | timestamptz | DERIVED | All arithmetic uses this |
| `arrival_local`, `arrival_timezone`, `arrival_utc` | | REQ / DERIVED | Same |
| `arrival_day_offset` | int | DERIVED | `+1`/`+2`. **Compute it; never trust a feed's flag** |
| `block_minutes` | int | DERIVED | `arrival_utc − departure_utc` |
| `days_of_week` | bitmap | REQ | Combined with §5.3 FR-18: after a midnight crossing, leg 2's operating day is the *next* day. This is the most likely correctness bug in the app |
| `effective_from`, `effective_to` | date | REQ | Schedules are published in seasons |
| `departure_terminal`, `arrival_terminal` | text | P4 | Terminal-change MCT (FR-13) |
| `aircraft_type` | text | OPT | Display; weak proxy for comfort on a long leg |
| `stops` | int | REQ | A "direct" flight with a technical stop is not a nonstop — must be flagged or excluded |
| `is_charter`, `is_seasonal` | bool | REQ | Exclude charters |
| `cabin_classes[]` | list | P3 | |

---

## 6. Fare / offer (per leg, one-way)

Priced separately per leg, because that is literally the product. **Quotes expire** — every
one of these carries a TTL that the UI must respect and show.

| Field | Type | Need | Why |
|---|---|---|---|
| `total_amount`, `currency` | money | P3 | |
| `base_fare`, `taxes`, `carrier_fees` | money | P3 | Taxes on two one-ways ≠ taxes on a through ticket; sometimes much worse |
| `fare_brand` | text | P3 | |
| `is_basic_economy` | bool | P3 | Predicts no bag, no seat, no changes |
| `included_personal_item` / `carry_on` / `checked` | bool / count | P3 | The real comparison unit |
| `seats_remaining` | int | P3 | Urgency, and a weak availability signal |
| `is_refundable`, `change_fee` | | P4 | Leg-2 forfeit cost |
| `booking_deeplink` | url | REQ | |
| `quoted_at`, `expires_at` | timestamptz | P3 | Never show a stale price as current |
| `is_one_way_permitted` | bool | P4 | Some international markets price one-ways punitively; that can kill the whole idea on a given pair |

### 6.1 GoWild-specific (UC-1)

| Field | Need | Why |
|---|---|---|
| `gowild_eligible` | REQ for UC-1 | Not every Frontier flight is |
| `earliest_confirmable_at` | REQ for UC-1 | **Day before departure domestic, 10 days international.** This is the field that makes overnight GoWild self-connections structurally risky (FR-22) |
| `early_booking_charge` | REQ for UC-1 | ~$29–89/segment to book outside that window — the price of removing the risk |
| `blackout_dates[]` | REQ for UC-1 | |
| `pass_valid_from`, `pass_valid_to` | REQ for UC-1 | |

**Known gap:** GoWild seat inventory is capacity-controlled and exposed by no public API. We
can prove a *flight* exists; we can never promise a *GoWild seat* exists. Every UC-1 result
must say that (FR-23).

---

## 7. Connection rules

Hand-curated, small, high-leverage. Keyed by gateway airport.

| Field | Need | Why |
|---|---|---|
| `self_transfer_min_minutes[arrival_type][departure_type][has_bag]` | REQ | Our own MCT table (FR-13). Published airline MCT does **not** apply to separate tickets and using it would be actively dangerous |
| `requires_immigration` | REQ | Any international arrival; forced for any overnight |
| `requires_bag_recheck` | REQ | Assume `true` on separate tickets unless proven otherwise |
| `requires_security_rescreen` | P4 | |
| `terminal_transfer_minutes[from][to]` | P4 | |

---

## 8. Entry / visa matrix

Keyed `(passport_country, gateway_country)`. Legal-consequence data — treat with care.

| Field | Need | Why |
|---|---|---|
| `status` | REQ | `visa_free` / `eta_required` / `visa_required` / `not_permitted` |
| `eta_scheme` | REQ | K-ETA (Korea), ESTA (US), ETIAS (EU), eTA (Canada) |
| `eta_cost`, `eta_lead_time_days` | P4 | Feeds cost model and "can you even do this by your date" |
| `max_stay_days` | OPT | |
| `twov_available` | P4 | Transit-without-visa. **Note it explicitly does not help here** — an overnight layover means entering the country |
| `source_url`, `checked_at` | REQ | Must be citable and dated |

The app's stance: advisory only, always cite and date the source, always tell the user to
confirm with the government. Getting this wrong strands someone at a border.

---

## 9. Cost inputs beyond airfare

| Field | Need | Why |
|---|---|---|
| `hotel_nightly_rate(gateway, date)` | P3 | An overnight layover has a bed in it. Often the deciding number |
| `airport_hotel_transfer_cost` | P4 | |
| `fx_rates` | P3 | One display currency, or the comparison is meaningless |
| `public_holidays(country, date)` | OPT | Hotel price spikes and immigration queues |

---

## 10. Derived itinerary object

What the engine actually emits. Nothing here is stored from a feed.

```
Itinerary
  legs[]                      → ScheduledFlight + Fare
  gateway_airport             → iata
  gateway_metro               → iata (differs from above ⇒ airport change, FR-15)
  layover_minutes             DERIVED  leg2.departure_utc − leg1.arrival_utc
  layover_class               DERIVED  short | long | overnight | stopover   (§2.1 rule)
  nights_required             DERIVED  local calendar dates spanned at gateway
  total_elapsed_minutes       DERIVED  last arrival_utc − first departure_utc
  arrival_day_offset          DERIVED
  connect_min_required        DERIVED  from §7 given bags + intl/dom
  slack_minutes               DERIVED  layover_minutes − connect_min_required
  required_actions[]          DERIVED  recheck_bag | clear_immigration | change_terminal
                                       | change_airport | leave_secure_area | overnight_stay
  feasible                    DERIVED  slack ≥ 0 ∧ visa ok ∧ airport open ∧ transfer possible
  infeasible_reasons[]        DERIVED  powers the honest empty state (FR-30)
  total_cost                  DERIVED  fares + bags×2 + seats + hotel + transfer + eta fee
  baseline_through_fare       P3       cheapest single-ticket A→B, same dates
  savings                     DERIVED  baseline − total_cost   (can and should go negative)
  risk_score                  P4       leg1 OTP, slack, is-last-flight, fallback count
  fallback_flights_count      P4       later leg-2 departures if leg 1 is late — the single
                                       best predictor of whether a bad day is survivable
  earliest_confirmable_at     UC-1     max over legs — the GoWild sequential-booking problem
```

---

## 11. What we deliberately do not model

- Hidden-city / throwaway ticketing (§1.2 of requirements) — no fields, no support.
- Loyalty accrual, upgrades, award pricing.
- Seat maps, meals, ancillaries beyond bags and seats.
- 3+ leg self-transfers in v1. Risk compounds multiplicatively.
- Ground transport as a leg (train/bus between gateways). Interesting later, out now.

---

## 12. Highest-risk data gaps

Ranked by "how badly does this hurt if we get it wrong":

1. **Real dated schedules with local times + timezones (§5).** No substitute. Without it
   there is no overnight detection and therefore no product. Buying decision — see
   [`03-data-sources.md`](./03-data-sources.md).
2. **Timezone correctness (§0).** Free to get right, catastrophic to get wrong, and invisible
   in testing until someone flies over the date line.
3. **GoWild booking window (§6.1).** Discovered during research; structurally undermines the
   naive UC-1 flow. Must be designed around, not patched later.
4. **Self-transfer MCT (§7).** No free source. Wrong values here either hide good options or
   strand users. Hand-curate for the top gateways and be conservative.
5. **Visa/entry (§8).** Small dataset, legal consequences, must be dated and cited.
6. **Baseline through-fare (§9/FR-20).** Without it the app can show a "saving" that isn't one.
