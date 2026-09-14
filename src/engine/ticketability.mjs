/**
 * Can two segments share one ticket? — requirements §8.5.
 *
 * This is the check that keeps the app on the right side of D-5. If two segments
 * cannot be sold together, what we have is a self-transfer, which is a different
 * and much riskier product that we deliberately do not build.
 *
 * We never assert ticketability. We rank confidence and let the carrier's own
 * multi-city search settle it (FR-32).
 */

import carriersData from '../../data/carriers.json' with { type: 'json' };

const allianceOf = new Map();
for (const [alliance, members] of Object.entries(carriersData.alliances)) {
  for (const c of members) allianceOf.set(c, alliance);
}

export const ALLIANCE_OF = allianceOf;

/**
 * @returns {{status:'same'|'alliance'|'unknown', confidence:'high'|'medium'|'low', note:string}}
 */
export function ticketability(carrierA, carrierB) {
  if (!carrierA || !carrierB) {
    return { status: 'unknown', confidence: 'low', note: 'Carrier unknown on at least one leg.' };
  }
  if (carrierA === carrierB) {
    return {
      status: 'same',
      confidence: 'high',
      note: 'Same carrier — bookable as one multi-city itinerary.',
    };
  }
  const a = allianceOf.get(carrierA);
  const b = allianceOf.get(carrierB);
  if (a && a === b) {
    return {
      status: 'alliance',
      confidence: 'medium',
      note: `Both ${a === 'star' ? 'Star Alliance' : a === 'oneworld' ? 'oneworld' : 'SkyTeam'} — `
        + 'usually ticketable together, but not guaranteed. Confirm in the carrier\'s multi-city search.',
    };
  }
  return {
    status: 'unknown',
    confidence: 'low',
    note: 'Different carriers with no known alliance link. These may not sell as one ticket — '
      + 'if they do not, this becomes a self-transfer with no missed-connection protection.',
  };
}
