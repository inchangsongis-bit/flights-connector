/**
 * Disk cache for airport-day departure boards.
 *
 * The free tier is roughly 600 units a month and every call costs several, so
 * re-running the same search must not re-spend quota. A board for (SEA,
 * 2026-10-13, 06-18) is identical for every user and every route that passes
 * through it, which makes this cache unusually effective: the second search of
 * an evening is typically free.
 *
 * Schedules for a date weeks out barely move, so the default TTL is generous.
 * Entries are plain JSON on disk — inspectable, and trivially cleared with `rm`.
 */

import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_TTL_HOURS = 24;

/**
 * @param {object} opts
 * @param {{getDepartures: Function}} opts.source  the adapter to wrap
 * @param {string} [opts.dir]                      cache directory
 * @param {number} [opts.ttlHours]
 * @param {boolean} [opts.verbose]                 log hits and misses
 */
export function withDiskCache({ source, dir = '.cache/schedules', ttlHours = DEFAULT_TTL_HOURS, verbose = false }) {
  const stats = { hits: 0, misses: 0, writes: 0 };
  const key = (airport, date, from, to) => `${airport}_${date}_${from}-${to}.json`;

  async function getDepartures(airport, date, opts = {}) {
    const { fromHour = 6, toHour = 18 } = opts;
    const file = join(dir, key(airport, date, fromHour, toHour));

    try {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      const ageHours = (Date.now() - raw.cachedAt) / 3600000;
      if (ageHours < ttlHours) {
        stats.hits += 1;
        if (verbose) console.log(`    cache hit  ${airport} ${date} (${ageHours.toFixed(1)}h old)`);
        // Dates serialise to strings; the engine requires real instants.
        return raw.flights.map((f) => ({
          ...f,
          departureUtc: f.departureUtc ? new Date(f.departureUtc) : null,
          arrivalUtc: f.arrivalUtc ? new Date(f.arrivalUtc) : null,
        }));
      }
      if (verbose) console.log(`    cache stale ${airport} ${date} (${ageHours.toFixed(1)}h)`);
    } catch {
      // No entry, or unreadable. Either way, fetch.
    }

    stats.misses += 1;
    if (verbose) console.log(`    fetching   ${airport} ${date}`);
    const flights = await source.getDepartures(airport, date, opts);

    try {
      await mkdir(dir, { recursive: true });
      await writeFile(file, JSON.stringify({ cachedAt: Date.now(), airport, date, flights }));
      stats.writes += 1;
    } catch (err) {
      // A cache that cannot write is a slow cache, not a broken program.
      if (verbose) console.log(`    cache write failed: ${err.message}`);
    }
    return flights;
  }

  return {
    getDepartures,
    stats: () => ({ ...stats }),
    async info() {
      try {
        const files = await readdir(dir);
        let bytes = 0;
        for (const f of files) bytes += (await stat(join(dir, f))).size;
        return { entries: files.length, bytes, dir };
      } catch {
        return { entries: 0, bytes: 0, dir };
      }
    },
  };
}
