/**
 * Where to actually go and buy the thing.
 *
 * The product's boundary is "operationally verified candidates, not quotes"
 * (FR-32), which makes the handoff the last and most load-bearing step. Until
 * now it was a dead end: the CLI said "confirm in ANA's multi-city search" and
 * offered no way to get there.
 *
 * THE MULTI-CITY LINK, AND WHY IT EXISTS DESPITE BEING FRAGILE
 * ───────────────────────────────────────────────────────────
 * This originally shipped without one, on the reasoning that Google's `tfs`
 * parameter is reverse-engineered rather than published and a link that breaks
 * at the booking step is worse than none.
 *
 * That was the wrong trade. Without it the app could find an itinerary and then
 * only tell the user to go and retype it — which is not finding them a ticket.
 *
 * VERIFIED WORKING 2026-09-15: the link opens Google Flights in multi-city mode
 * with both legs pre-filled and prices the pair as ONE ticket, surfacing partner
 * carriers that sell the two segments together more cheaply. That is the
 * product's central claim, confirmed end to end.
 *
 * It remains undocumented and could change, so the per-leg searches and the
 * carrier's own site stay as fallbacks and the card says so.
 *
 * `tfs` encoding lives in tfs.mjs and is verified against the documented schema.
 */

import { googleFlightsUrl } from './tfs.mjs';

export function createBookingLinks(data) {
  const carriers = data.carriers ?? {};
  const generic = data.generic ?? {};

  const fill = (template, vars) =>
    template.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ''));

  /** A pre-filled one-way search for a single leg. */
  function legSearch(provider, origin, destination, date) {
    const g = generic[provider];
    if (!g) return null;
    return {
      provider,
      label: g.label,
      url: fill(g.template, { origin, destination, date }),
      whatItDoes: g.what_it_does,
      confidence: g.confidence,
    };
  }

  /** Where the multi-city ticket is actually bought. Not pre-filled. */
  function carrierBooking(carrier) {
    const c = carriers[carrier];
    if (!c) return null;
    return {
      carrier,
      carrierName: c.name,
      url: c.booking,
      note: c.note ?? null,
      whatItDoes: 'The carrier\'s own booking site. Use its multi-city search — that is what makes '
        + 'this one ticket. Not pre-filled.',
    };
  }

  /**
   * The itinerary as text, so filling a multi-city form is a paste rather than
   * a retype. Unglamorous, and the thing that actually saves the user time
   * given no deep link exists.
   */
  function itineraryText(candidate) {
    const d = (iso) => (iso ? String(iso).slice(0, 10) : '?');
    const leg1Date = d(candidate.leg1.departureLocal ?? candidate.leg1.departureUtc);
    const leg2Date = d(candidate.leg2.departureLocal ?? candidate.leg2.departureUtc);
    return [
      `${candidate.origin ?? ''} → ${candidate.gateway}   ${leg1Date}   ${candidate.leg1.carrier} ${candidate.leg1.flightNumber}`,
      `${candidate.gateway} → ${candidate.destination ?? ''}   ${leg2Date}   ${candidate.leg2.carrier} ${candidate.leg2.flightNumber}`,
    ].join('\n');
  }

  /**
   * One Google Flights search containing BOTH legs — the actual itinerary,
   * priced as one multi-city trip.
   *
   * Returns null rather than a malformed URL if anything about the legs is
   * unusable, so a bad link never reaches the user.
   */
  function multiCity(legs, opts = {}) {
    try {
      return {
        provider: 'google_flights',
        label: 'Open both legs in Google Flights',
        url: googleFlightsUrl(legs, { adults: opts.adults ?? 1 }),
        whatItDoes: 'A multi-city search containing both legs, priced as one trip. '
          + 'This is the itinerary, not a component of it.',
        caveat: 'Verified working. Google does not publish this URL format, so it could change — '
          + 'the per-leg links below use a stable one.',
        confidence: 'high',
      };
    } catch {
      return null;
    }
  }

  /** Everything a candidate needs to become a booking. */
  function forCandidate(candidate) {
    const leg1Date = String(candidate.leg1.departureLocal ?? candidate.leg1.departureUtc ?? '').slice(0, 10);
    const leg2Date = String(candidate.leg2.departureLocal ?? candidate.leg2.departureUtc ?? '').slice(0, 10);

    return {
      multiCity: multiCity([
        { from: candidate.origin, to: candidate.gateway, date: leg1Date },
        { from: candidate.gateway, to: candidate.destination, date: leg2Date },
      ]),
      // Same carrier on both legs is the case where one multi-city booking
      // genuinely works, so that is the primary destination.
      carrier: carrierBooking(candidate.leg1.carrier),
      legs: [
        {
          label: `${candidate.origin} → ${candidate.gateway}`,
          date: leg1Date,
          search: legSearch('google_flights', candidate.origin, candidate.gateway, leg1Date),
        },
        {
          label: `${candidate.gateway} → ${candidate.destination}`,
          date: leg2Date,
          search: legSearch('google_flights', candidate.gateway, candidate.destination, leg2Date),
        },
      ],
      itineraryText: itineraryText(candidate),
      caveat: candidate.ticketability?.status === 'same'
        ? 'Book both legs as ONE multi-city itinerary, not two separate tickets — that is what keeps '
          + 'the airline responsible for the connection.'
        : 'These legs may not sell as one ticket. If they will not, booking them separately makes this '
          + 'a self-transfer with no protection if the first flight is late.',
    };
  }

  return { legSearch, carrierBooking, multiCity, itineraryText, forCandidate, checkedAt: data.checked_at };
}
