/**
 * Matches a candidate against the hand-curated stopover programme table.
 *
 * Encodes the trap documented in data/README.md: a carrier-provided hotel that
 * requires no shorter connection to exist will normally NOT apply to a layover
 * the passenger deliberately chose. Emirates' Dubai Connect is the confirmed
 * case. Telling someone they get a free hotel when choosing the long layover
 * disqualifies them costs them a night they did not budget for.
 */

import programsData from '../../data/stopover-programs.json' with { type: 'json' };

const byCarrier = new Map(programsData.carriers.map((c) => [c.carrier_iata, c]));

export const PROGRAMS_CHECKED_AT = programsData.checked_at;

/**
 * @param {string} carrier      validating/operating carrier
 * @param {string} airport      the layover airport IATA
 * @param {object} layover      result of classifyLayover()
 * @param {boolean} chosen      true when the user deliberately selected this
 *                              long layover (always true in Mode B)
 */
export function matchStopoverProgram(carrier, airport, layover, chosen = true) {
  const p = byCarrier.get(carrier);
  if (!p) return null;
  if (!p.hub_airports.includes(airport)) return null;

  const hours = layover.minutes / 60;
  const out = {
    carrier: p.carrier_iata,
    carrierName: p.carrier_name,
    confidence: p.confidence,
    verifyBeforeDisplay: p.verify_before_display,
    sources: p.sources,
    highlights: [],
  };

  const fare = p.fare_stopover;
  if (fare?.available === true) {
    out.fareStopover = fare;
    if (fare.free_per_direction >= 1) {
      out.highlights.push({
        kind: 'free_stopover',
        text: `${p.carrier_name}: first stopover free per direction`
          + (fare.additional_fee ? `, second ${fare.additional_fee.amount} ${fare.additional_fee.currency}` : ''),
      });
    }
  } else if (fare?.available === 'unofficial') {
    out.highlights.push({
      kind: 'unofficial',
      text: `${p.carrier_name} publishes no stopover programme, but multi-city pricing is often `
        + 'at or below the equivalent connecting fare. Worth pricing — no guarantee.',
    });
  }

  const hotel = p.carrier_provided_hotel;
  if (hotel?.available === true) {
    const meetsHours = hotel.min_layover_hours == null || hours >= hotel.min_layover_hours;
    if (hotel.requires_no_shorter_connection === true && chosen) {
      out.highlights.push({
        kind: 'hotel_disqualified',
        text: `${hotel.program_name ?? 'The free hotel'} applies only when no shorter connection `
          + 'exists. Choosing this longer layover will normally disqualify you — budget for the hotel.',
      });
    } else if (meetsHours) {
      out.highlights.push({
        kind: hotel.requires_no_shorter_connection === 'unknown' ? 'hotel_conditional' : 'hotel_possible',
        text: `${p.carrier_name} may provide a hotel`
          + (hotel.min_layover_hours ? ` on layovers over ${hotel.min_layover_hours}h` : '')
          + (hotel.requires_no_shorter_connection === 'unknown'
            ? '. May not apply to a stopover you chose — confirm with the carrier.'
            : '. Confirm eligibility with the carrier.'),
      });
    }
  }

  const tour = p.transit_tour;
  if (tour?.available === true) {
    const min = tour.min_layover_hours ?? 0;
    const max = tour.max_layover_hours ?? Infinity;
    if (hours >= min && hours <= max) {
      out.highlights.push({
        kind: 'transit_tour',
        text: `${tour.program_name ?? 'Free transit tour'} available on layovers of ${min}h+.`,
      });
    }
  }

  const pkg = p.paid_stopover_package;
  if (pkg?.available === true && pkg.price_from) {
    out.highlights.push({
      kind: 'paid_package',
      text: `${pkg.program_name} — hotels from ${pkg.price_from.amount} ${pkg.price_from.currency} per night.`,
    });
  }

  return out.highlights.length ? out : null;
}

/** Every carrier with a programme at this airport — used to hint at better routings. */
export function programsAtAirport(airport) {
  return programsData.carriers.filter((c) => c.hub_airports.includes(airport));
}
