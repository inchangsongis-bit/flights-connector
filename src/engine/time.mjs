/**
 * Time handling. The single highest-risk area in this codebase (NFR-1).
 *
 * Rules, without exception:
 *   - every instant is a JS Date (a UTC instant) plus the IANA zone it happened in
 *   - every duration is computed from UTC instants, never from local clock times
 *   - local wall-clock values are derived for display and classification only
 *
 * Seattle → Tokyo → Seoul crosses the international date line and, seasonally, a
 * DST boundary. Naive local-clock subtraction is wrong on both, and wrong quietly.
 *
 * No dependencies: Intl.DateTimeFormat with a timeZone is the platform's own
 * tz database, and it is correct.
 */

const formatters = new Map();

function formatterFor(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Wall-clock parts for a UTC instant, in a given IANA zone. */
export function localParts(instant, tz) {
  const parts = Object.fromEntries(
    formatterFor(tz).formatToParts(instant)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return {
    year, month, day, hour, minute,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    minuteOfDay: hour * 60 + minute,
  };
}

/** Local calendar date, 'YYYY-MM-DD', for an instant in a zone. */
export const localDate = (instant, tz) => localParts(instant, tz).date;

/** Whole days between two 'YYYY-MM-DD' strings. Calendar days, not elapsed time. */
export function calendarDaysBetween(fromDate, toDate) {
  const a = Date.UTC(...fromDate.split('-').map(Number).map((n, i) => (i === 1 ? n - 1 : n)));
  const b = Date.UTC(...toDate.split('-').map(Number).map((n, i) => (i === 1 ? n - 1 : n)));
  return Math.round((b - a) / 86400000);
}

/** Elapsed minutes between two instants. Always UTC-based. */
export function elapsedMinutes(from, to) {
  return (to.getTime() - from.getTime()) / 60000;
}

/**
 * Minutes of the interval falling inside a local-time window at `tz`.
 *
 * Walks the interval in fixed steps rather than converting the window's local
 * boundaries back to UTC — the local→UTC direction is ambiguous across DST
 * transitions (a wall-clock time can occur twice or not at all), and this
 * sampling approach simply has no such failure mode. `stepMinutes` bounds the
 * error; the callers are estimates by nature.
 *
 * `endHour < startHour` means the window wraps midnight, e.g. 23:00–07:00.
 */
export function minutesInLocalWindow(from, to, tz, startHour, endHour, stepMinutes = 5) {
  const total = elapsedMinutes(from, to);
  if (total <= 0) return 0;
  const wraps = endHour <= startHour;
  let inside = 0;
  for (let offset = 0; offset < total; offset += stepMinutes) {
    const hour = localParts(new Date(from.getTime() + offset * 60000), tz).hour;
    const hit = wraps ? (hour >= startHour || hour < endHour) : (hour >= startHour && hour < endHour);
    if (hit) inside += Math.min(stepMinutes, total - offset);
  }
  return inside;
}

/** Does the interval touch a local-time window at all? */
export function intersectsLocalWindow(from, to, tz, startHour, endHour) {
  return minutesInLocalWindow(from, to, tz, startHour, endHour, 5) > 0;
}

/** 'PT16H35M' → 995. Returns null on anything unparseable. */
export function isoDurationToMinutes(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(iso ?? '');
  if (!m) return null;
  return Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** 995 → '16h 35m' */
export function formatMinutes(mins) {
  if (mins == null || Number.isNaN(mins)) return '?';
  const sign = mins < 0 ? '-' : '';
  const v = Math.abs(Math.round(mins));
  return `${sign}${Math.floor(v / 60)}h ${String(v % 60).padStart(2, '0')}m`;
}
