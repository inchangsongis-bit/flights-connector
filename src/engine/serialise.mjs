/**
 * Search results → the JSON the Layover Board reads.
 *
 * Kept in the engine rather than inline in the CLI so the writer and the page
 * cannot drift apart — the same mistake already made once with the browser
 * engine and once with the probe script's parser.
 *
 * Instants become ISO strings here; the page keeps them as strings for display
 * only, because every duration was already computed on real instants upstream.
 */

function leg(l) {
  return {
    carrier: l.carrier ?? null,
    carrierName: l.carrierName ?? null,
    flightNumber: l.flightNumber ?? null,
    destination: l.destination ?? null,
    departureUtc: l.departureUtc?.toISOString() ?? null,
    arrivalUtc: l.arrivalUtc?.toISOString() ?? null,
    departureLocal: l.departureLocal ?? null,
    arrivalLocal: l.arrivalLocal ?? null,
    aircraft: l.aircraft ?? null,
  };
}

export function toExportPayload({ query, result, generatedAt = new Date() }) {
  return {
    generatedAt: generatedAt.toISOString(),
    query,
    apiCalls: result.apiCalls,
    reason: result.reason ?? null,
    gateways: result.gateways.map((g) => ({
      via: g.via,
      city: g.viaCity,
      country: g.viaCountry,
      detourRatio: g.detourRatio,
      ticketability: g.ticketability,
      stopoverPrograms: g.stopoverPrograms,
    })),
    candidates: result.candidates.map((c) => ({
      gateway: c.gateway,
      gatewayCity: c.gatewayCity,
      gatewayCountry: c.gatewayCountry,
      detourRatio: c.detourRatio,
      leg1: leg(c.leg1),
      leg2: leg(c.leg2),
      layoverMinutes: c.layover.minutes,
      layoverClass: c.layover.class,
      isOvernight: c.layover.isOvernight,
      nightsRequired: c.layover.nightsRequired,
      usableCityHours: c.usableCityHours,
      ticketability: c.ticketability,
      programHighlights: c.program?.highlights ?? [],
      entry: c.entry && {
        status: c.entry.status,
        summary: c.entry.summary ?? null,
        note: c.entry.note ?? null,
        confidence: c.entry.confidence,
        scheme: c.entry.scheme ?? null,
        maxStayDays: c.entry.maxStayDays ?? null,
        arrivalFormalities: c.entry.arrivalFormalities ?? [],
        sources: c.entry.sources ?? [],
      },
      entryChange: c.entryChange && { from: c.entryChange.from, text: c.entryChange.text },
      booking: c.booking ?? null,
      baggage: c.baggage && {
        status: c.baggage.status,
        text: c.baggage.text,
        confidence: c.baggage.confidence,
        koreanCustoms: c.baggage.koreanCustoms,
      },
    })),
  };
}
