/**
 * Will the bag follow you, or do you collect and re-check it?
 *
 * The one practical footgun that survived the single-ticket pivot. On one ticket
 * bags are usually through-checked — but carriers cap it, and the caps differ by
 * a factor of two.
 *
 * THE 24-HOUR LINE, AGAIN
 * ───────────────────────
 * The same boundary that separates a stopover from a connection governs baggage
 * on most carriers: under 24h the bag goes through, over it the traveller
 * collects and re-checks. So the app's 8-24h sweet spot is normally fine — you
 * walk into the city with a daypack.
 *
 * Except on US carriers, which cap it around 12h. A 16-hour Tokyo layover is
 * comfortably inside ANA's limit and outside United's, and nothing on a booking
 * page tells you that.
 */

export function createBaggageRules(data) {
  const carriers = data.carriers ?? {};

  /**
   * @param {string} carrier      operating carrier of the inbound leg
   * @param {number} layoverHours
   * @param {object} [opts]
   * @param {string} [opts.gatewayCountry]  ISO alpha-2 of the layover country
   */
  function throughCheck(carrier, layoverHours, opts = {}) {
    const rule = carriers[carrier];

    // Korean customs require collection at the first point of entry regardless
    // of what the tag says — a rule about the border, not about the airline.
    const koreanCustoms = opts.gatewayCountry === 'KR';

    if (!rule) {
      return {
        status: 'unknown',
        carrier,
        limitHours: null,
        confidence: 'none',
        sources: [],
        koreanCustoms,
        text: `No through-check policy recorded for ${carrier}. Confirm at check-in whether your `
          + 'bag goes to the final destination or comes out at the connection.',
      };
    }

    const base = { carrier, carrierName: rule.name, confidence: rule.confidence, sources: rule.sources ?? [], koreanCustoms };

    if (rule.max_hours == null) {
      return {
        ...base,
        status: 'unknown',
        limitHours: null,
        text: `${rule.name} publishes no clear limit. ${rule.note ?? ''} Confirm at check-in.`.trim(),
      };
    }

    const limit = rule.max_hours;
    const extended = rule.extended_hours ?? null;

    if (layoverHours <= limit) {
      return {
        ...base,
        status: 'through_checked',
        limitHours: limit,
        text: `Your bag should go through to the destination — ${formatH(layoverHours)} is inside `
          + `${rule.name}'s ${formatH(limit)} limit.`,
      };
    }

    if (extended && layoverHours <= extended) {
      return {
        ...base,
        status: 'conditional',
        limitHours: limit,
        extendedHours: extended,
        text: `${formatH(layoverHours)} is past ${rule.name}'s ${formatH(limit)} base limit but inside `
          + `the ${formatH(extended)} allowed on its own and partner itineraries. ${rule.extended_note ?? ''} `
          + 'Confirm at check-in.',
      };
    }

    return {
      ...base,
      status: 'recheck',
      limitHours: limit,
      text: `Plan to collect and re-check your bag — ${formatH(layoverHours)} exceeds ${rule.name}'s `
        + `${formatH(limit)} through-check limit.${rule.note ? ` ${rule.note}` : ''}`,
    };
  }

  return { throughCheck, checkedAt: data.checked_at };
}

const formatH = (h) => (Number.isInteger(h) ? `${h}h` : `${Math.floor(h)}h ${Math.round((h % 1) * 60)}m`);
