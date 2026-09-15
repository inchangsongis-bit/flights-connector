/**
 * Node entry: reads the committed JSON and builds a ready network.
 * The browser does the same thing with fetch(); see web/index.html.
 */
import airportsData from '../../data/airports.json' with { type: 'json' };
import routesData from '../../data/routes.json' with { type: 'json' };
import carriersData from '../../data/carriers.json' with { type: 'json' };
import programsData from '../../data/stopover-programs.json' with { type: 'json' };
import { createNetwork } from './network.mjs';

export const PROGRAMS_CHECKED_AT = programsData.checked_at;
export const ROUTE_GRAPH_GENERATED_AT = routesData._generated_at;

export const network = createNetwork({
  airports: airportsData.airports,
  routes: routesData.routes,
  alliances: carriersData.alliances,
  programs: programsData.carriers,
  meta: { routeGraphGeneratedAt: routesData._generated_at, programsCheckedAt: programsData.checked_at },
});
