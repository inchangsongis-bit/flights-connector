/**
 * Network reasoning: gateways, distance, ticketability, stopover programmes.
 *
 * Data is INJECTED, not imported. That is the whole point of this module: the
 * browser and Node both call createNetwork() with the same shapes, so there is
 * one implementation of these rules rather than two that drift apart.
 *
 *   Node:    import { loadNetwork } from './data-node.mjs'
 *   Browser: createNetwork(await (await fetch('data.json')).json())
 *
 * `time.mjs` and `layover.mjs` are pure and are imported directly by both.
 */

const ALLIANCE_LABEL = { star: 'Star Alliance', oneworld: 'oneworld', skyteam: 'SkyTeam' };
const STATUS_RANK = { same: 0, alliance: 1, unknown: 2 };
const toRad = (d) => (d * Math.PI) / 180;

/**
 * @param {object} data
 * @param {Record<string,{iata,name,city,country,lat,lon,tz,metro?}>} data.airports
 * @param {Record<string,string[]>} data.routes            "SEA-NRT" -> ["NH","UA"]
 * @param {Record<string,string[]>} data.alliances         "star" -> ["NH",...]
 * @param {Array<object>} data.programs                    stopover-programme rows
 */
export function createNetwork(data) {
  const airports = data.airports;
  const routes = data.routes;

  const allianceOf = new Map();
  for (const [alliance, members] of Object.entries(data.alliances ?? {})) {
    for (const c of members) allianceOf.set(c, alliance);
  }

  const programs = data.programs ?? [];
  const programByCarrier = new Map(programs.map((p) => [p.carrier_iata, p]));

  const airport = (iata) => airports[iata] ?? null;

  function distanceKm(a, b) {
    const A = airports[a];
    const B = airports[b];
    if (!A || !B) return null;
    const dLat = toRad(B.lat - A.lat);
    const dLon = toRad(B.lon - A.lon);
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(A.lat)) * Math.cos(toRad(B.lat)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(h));
  }

  /**
   * How far out of the way a gateway takes you: (O→C + C→D) / O→D.
   * Without it the route graph proposes Seattle → Dubai → Seoul (2.23×)
   * alongside Seattle → Tokyo → Seoul (1.06×). Both are two flights that
   * exist; only one is a stopover rather than a different trip.
   */
  function detourRatio(origin, via, destination) {
    const direct = distanceKm(origin, destination);
    const legs = distanceKm(origin, via) + distanceKm(via, destination);
    return (!direct || !legs) ? null : legs / direct;
  }

  function metroSiblings(iata) {
    const a = airports[iata];
    if (!a?.metro) return [iata];
    return Object.keys(airports).filter((k) => airports[k].metro === a.metro);
  }

  /** Accept either an airport code or a metropolitan code (TYO ⇒ HND, NRT). */
  function expandToAirports(code) {
    if (airports[code]) return metroSiblings(code);
    const members = Object.keys(airports).filter((k) => airports[k].metro === code);
    return members.length ? members : [];
  }

  const carriersOn = (from, to) => routes[`${from}-${to}`] ?? [];

  /**
   * Can two segments share one ticket?
   *
   * Never asserted — ranked. If two segments cannot be sold together, what we
   * have is a self-transfer, a different and much riskier product that this app
   * deliberately does not build. The carrier's own multi-city search settles it.
   */
  function ticketability(carrierA, carrierB) {
    if (!carrierA || !carrierB) {
      return { status: 'unknown', confidence: 'low', note: 'Carrier unknown on at least one leg.' };
    }
    if (carrierA === carrierB) {
      return { status: 'same', confidence: 'high', note: 'Same carrier — bookable as one multi-city itinerary.' };
    }
    const a = allianceOf.get(carrierA);
    const b = allianceOf.get(carrierB);
    if (a && a === b) {
      return {
        status: 'alliance',
        confidence: 'medium',
        note: `Both ${ALLIANCE_LABEL[a] ?? a} — usually ticketable together, but not guaranteed. `
          + "Confirm in the carrier's multi-city search.",
      };
    }
    return {
      status: 'unknown',
      confidence: 'low',
      note: 'Different carriers with no known alliance link. These may not sell as one ticket — '
        + 'if they do not, this becomes a self-transfer with no missed-connection protection.',
    };
  }

  const programsAtAirport = (a) => programs.filter((p) => p.hub_airports.includes(a));

  /**
   * Match a candidate against the curated stopover-programme table.
   *
   * Encodes two findings that a naive implementation gets wrong:
   *
   *  1. THE 24-HOUR BOUNDARY. A stopover is a break of MORE than 24h (ANA states
   *     this explicitly). Below that it is an ordinary connection: no fare
   *     premium, and no stopover programme applies. Advertising one would be false.
   *  2. THE DUBAI CONNECT TRAP. A carrier-provided hotel conditioned on "no
   *     shorter connection available" will normally NOT apply to a layover the
   *     passenger deliberately chose. Promising it costs them an unbudgeted night.
   */
  function matchStopoverProgram(carrier, airportCode, layover, chosen = true) {
    const p = programByCarrier.get(carrier);
    if (!p || !p.hub_airports.includes(airportCode)) return null;

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
    const minHours = fare?.min_hours ?? 24;
    const qualifiesAsStopover = hours > minHours;
    out.qualifiesAsStopover = qualifiesAsStopover;

    if (fare?.available === true) {
      out.fareStopover = fare;
      if (fare.free_per_direction >= 1 && qualifiesAsStopover) {
        out.highlights.push({
          kind: 'free_stopover',
          text: `${p.carrier_name}: first stopover free per direction`
            + (fare.additional_fee ? `, second ${fare.additional_fee.amount} ${fare.additional_fee.currency}` : ''),
        });
      } else if (fare.free_per_direction >= 1) {
        out.highlights.push({
          kind: 'below_stopover_threshold',
          text: `Under ${minHours}h this is a connection, not a stopover, so `
            + `${p.carrier_name}'s free-stopover programme does not apply. It costs no fare premium `
            + `either. Extend past ${minHours}h to use the programme.`,
        });
      }
    } else if (fare?.available === 'unofficial' && qualifiesAsStopover) {
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

    return out.highlights.length ? out : null;
  }

  /** Lower is better: ticketability dominates, then a programme, then detour. */
  function rank(c) {
    return STATUS_RANK[c.ticketability.status] * 100
      + (c.stopoverPrograms?.length ? -30 : 0)
      + (c.detourRatio != null ? (c.detourRatio - 1) * 40 : 20);
  }

  function bestCrossCarrier(inbound, onward) {
    let best = { status: 'unknown', confidence: 'low', note: 'No known link between carriers.' };
    for (const a of inbound) {
      for (const b of onward) {
        const t = ticketability(a, b);
        if (t.status === 'alliance') return t;
        if (t.status !== 'unknown') best = t;
      }
    }
    return best;
  }

  /**
   * Every C where origin → C and C → destination are both flown.
   *
   * Runs entirely against the offline route graph: zero API calls. That is what
   * makes a metered schedule tier viable, since only the shortlist is ever
   * queried for real times.
   */
  function findGateways(origin, destination, opts = {}) {
    const { excludeMetros = [], onlySameCarrier = false, limit = 20, maxDetour = 1.5 } = opts;

    const origins = expandToAirports(origin);
    const destinations = expandToAirports(destination);
    if (!origins.length || !destinations.length) return [];

    const originMetros = new Set(origins.map((a) => airports[a]?.metro ?? a));
    const destMetros = new Set(destinations.map((a) => airports[a]?.metro ?? a));

    // Origin and destination in the same city is not a journey with a stopover,
    // it is a round trip. Without this guard the graph cheerfully returns
    // SEA → anywhere → SEA, and the detour filter cannot catch it either, since
    // the nonstop distance is zero and the ratio comes out undefined.
    if ([...originMetros].every((m) => destMetros.has(m))
        && [...destMetros].every((m) => originMetros.has(m))) {
      return [];
    }
    const candidates = new Map();

    for (const from of origins) {
      const prefix = `${from}-`;
      for (const key of Object.keys(routes)) {
        if (!key.startsWith(prefix)) continue;
        const via = key.slice(prefix.length);
        const viaMetro = airports[via]?.metro ?? via;

        // A "connection" in the origin or destination city is not a connection.
        if (originMetros.has(viaMetro) || destMetros.has(viaMetro)) continue;
        if (excludeMetros.includes(viaMetro)) continue;

        const inbound = routes[key];
        for (const to of destinations) {
          const onward = carriersOn(via, to);
          if (!onward.length) continue;

          const detour = detourRatio(from, via, to);
          if (detour != null && detour > maxDetour) continue;

          const sameCarrier = inbound.filter((c) => onward.includes(c));
          if (onlySameCarrier && !sameCarrier.length) continue;

          const tkt = sameCarrier.length
            ? ticketability(sameCarrier[0], sameCarrier[0])
            : bestCrossCarrier(inbound, onward);
          if (tkt.status === 'unknown' && onlySameCarrier) continue;

          const candidate = {
            origin: from,
            via,
            destination: to,
            viaMetro,
            viaCity: airports[via]?.city ?? via,
            viaCountry: airports[via]?.country ?? null,
            viaTz: airports[via]?.tz ?? null,
            detourRatio: detour,
            inboundCarriers: inbound,
            onwardCarriers: onward,
            sameCarrier,
            ticketability: tkt,
            stopoverPrograms: programsAtAirport(via)
              .filter((p) => sameCarrier.includes(p.carrier_iata) || inbound.includes(p.carrier_iata))
              .map((p) => p.carrier_iata),
          };

          // Dedupe per (origin, gateway, destination METRO): arriving ICN vs GMP
          // is a real difference, listing the gateway twice is noise.
          const id = `${from}-${via}-${airports[to]?.metro ?? to}`;
          const existing = candidates.get(id);
          if (existing && rank(existing) <= rank(candidate)) continue;
          candidates.set(id, candidate);
        }
      }
    }

    return [...candidates.values()].sort((a, b) => rank(a) - rank(b)).slice(0, limit);
  }

  return {
    airports,
    routes,
    airport,
    distanceKm,
    detourRatio,
    metroSiblings,
    expandToAirports,
    ticketability,
    programsAtAirport,
    matchStopoverProgram,
    findGateways,
    meta: data.meta ?? null,
  };
}
