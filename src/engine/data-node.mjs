/**
 * Node entry: reads the committed JSON and builds a ready network.
 * The browser does the same thing with fetch(); see web/index.html.
 */
import airportsData from '../../data/airports.json' with { type: 'json' };
import routesData from '../../data/routes.json' with { type: 'json' };
import carriersData from '../../data/carriers.json' with { type: 'json' };
import programsData from '../../data/stopover-programs.json' with { type: 'json' };
import entryData from '../../data/entry-rules.json' with { type: 'json' };
import baggageData from '../../data/baggage-rules.json' with { type: 'json' };
import bookingData from '../../data/booking-links.json' with { type: 'json' };
import { createNetwork } from './network.mjs';
import { createEntryRules } from './entry.mjs';
import { createBaggageRules } from './baggage.mjs';
import { createBookingLinks } from './booking.mjs';

export const PROGRAMS_CHECKED_AT = programsData.checked_at;
export const ENTRY_CHECKED_AT = entryData.checked_at;
export const entryRules = createEntryRules(entryData);
export const baggageRules = createBaggageRules(baggageData);
export const bookingLinks = createBookingLinks(bookingData);
export const ROUTE_GRAPH_GENERATED_AT = routesData._generated_at;

export const network = createNetwork({
  airports: airportsData.airports,
  routes: routesData.routes,
  alliances: carriersData.alliances,
  programs: programsData.carriers,
  meta: { routeGraphGeneratedAt: routesData._generated_at, programsCheckedAt: programsData.checked_at },
});
