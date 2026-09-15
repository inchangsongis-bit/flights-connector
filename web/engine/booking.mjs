/**
 * Where to actually go and buy the thing.
 *
 * The product's boundary is "operationally verified candidates, not quotes"
 * (FR-32), which makes the handoff the last and most load-bearing step. Until
 * now it was a dead end: the CLI said "confirm in ANA's multi-city search" and
 * offered no way to get there.
 *
 * WHY THERE IS NO MULTI-CITY DEEP LINK
 * ────────────────────────────────────
 * Neither Google Flights nor Kayak publishes a stable multi-city URL format.
 * Google's `tfs` parameter is a base64url-encoded protobuf that was
 * reverse-engineered, not documented, and changes without notice.
 *
 * A link that silently breaks at the booking step is worse than no link. By then
 * the user has invested a search, and a dead handoff discredits everything
 * upstream of it. So this module generates only links whose formats are
 * ordinary and user-facing, and labels each one by what it actually does.
 */

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

  /** Everything a candidate needs to become a booking. */
  function forCandidate(candidate) {
    const leg1Date = String(candidate.leg1.departureLocal ?? candidate.leg1.departureUtc ?? '').slice(0, 10);
    const leg2Date = String(candidate.leg2.departureLocal ?? candidate.leg2.departureUtc ?? '').slice(0, 10);

    return {
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

  return { legSearch, carrierBooking, itineraryText, forCandidate, checkedAt: data.checked_at };
}
