/**
 * Layover classification — requirements §2.1.
 *
 * SPEC CORRECTION (found while implementing, 2026-09-14)
 * ─────────────────────────────────────────────────────
 * The requirements originally read: overnight if (a) the local departure date
 * is later than the local arrival date, OR (b) the layover is >= 8h and touches
 * local 01:00-05:00.
 *
 * As written, OR makes (b) dead weight and misclassifies a 23:50 -> 00:20
 * connection as "overnight" — it crosses a local midnight, so (a) fires. Thirty
 * minutes is not a night in Tokyo. The doc's own commentary said such a case
 * should be rejected, so the prose and the rule disagreed.
 *
 * Implemented rule, which matches the stated intent:
 *
 *   overnight  ⟺  layover >= MIN_OVERNIGHT_MINUTES
 *                 AND (crosses a local calendar date OR touches local 01:00-05:00)
 *
 * The duration test is the gate; the date/night test distinguishes a genuine
 * night on the ground from a long daytime sit. Both are needed.
 */

import {
  elapsedMinutes, localDate, localParts, calendarDaysBetween,
  intersectsLocalWindow, minutesInLocalWindow,
} from './time.mjs';

export const MIN_OVERNIGHT_MINUTES = 8 * 60;
export const LONG_LAYOVER_MINUTES = 6 * 60;
export const STOPOVER_MINUTES = 24 * 60;

/** Local hours treated as unusable for visiting a city. */
export const SLEEP_WINDOW = { start: 23, end: 7 };
/** Local hours whose presence in a layover marks it as spanning the night. */
export const NIGHT_WINDOW = { start: 1, end: 5 };

/**
 * @param {Date} arrival    leg 1 arrival, UTC instant
 * @param {Date} departure  leg 2 departure, UTC instant
 * @param {string} tz       IANA zone of the connection airport
 */
export function classifyLayover(arrival, departure, tz) {
  const minutes = elapsedMinutes(arrival, departure);
  if (!(minutes > 0)) {
    return { minutes, valid: false, class: 'invalid', isOvernight: false, nightsRequired: 0 };
  }

  const arrivalLocal = localParts(arrival, tz);
  const departureLocal = localParts(departure, tz);
  const daysSpanned = calendarDaysBetween(arrivalLocal.date, departureLocal.date);

  const crossesLocalDate = daysSpanned > 0;
  const touchesNight = intersectsLocalWindow(arrival, departure, tz, NIGHT_WINDOW.start, NIGHT_WINDOW.end);
  const isOvernight = minutes >= MIN_OVERNIGHT_MINUTES && (crossesLocalDate || touchesNight);

  const cls = minutes >= STOPOVER_MINUTES ? 'stopover'
    : minutes >= LONG_LAYOVER_MINUTES ? 'long'
      : 'short';

  return {
    minutes,
    valid: true,
    class: cls,
    isOvernight,
    // A midnight crossed without meeting the overnight bar needs no hotel.
    nightsRequired: isOvernight ? Math.max(1, daysSpanned) : 0,
    crossesLocalDate,
    touchesNight,
    arrivalLocal,
    departureLocal,
  };
}

/**
 * Hours actually available to spend in the city — requirements FR-16.
 *
 * A 14-hour layover landing at 01:00 is not a night in Tokyo, it is a night in a
 * terminal. Elapsed hours flatter a layover; this is the number that decides
 * whether it is worth anything.
 *
 * Subtracts the local sleep window, immigration, and the round trip to the city.
 * Deliberately conservative — overstating usable time is the failure that wastes
 * someone's trip.
 */
export function usableCityHours(arrival, departure, tz, opts = {}) {
  const { immigrationMinutes = 45, cityTransferMinutes = 60 } = opts;
  const total = elapsedMinutes(arrival, departure);
  if (!(total > 0)) return 0;

  const asleep = minutesInLocalWindow(arrival, departure, tz, SLEEP_WINDOW.start, SLEEP_WINDOW.end);
  const overhead = immigrationMinutes + cityTransferMinutes * 2;
  return Math.max(0, (total - asleep - overhead) / 60);
}

/** Short human label for a classified layover. */
export function describeLayover(c) {
  if (!c.valid) return 'invalid connection';
  if (c.isOvernight) {
    return c.nightsRequired > 1 ? `overnight, ${c.nightsRequired} nights` : 'overnight';
  }
  return { stopover: 'stopover (24h+)', long: 'long layover', short: 'short connection' }[c.class];
}
