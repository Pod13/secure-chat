// A tiny hash router: no dependency, and routes are a closed list so unknown paths cannot
// reach any page.

export type Route = 'home' | 'not-found';

const ROUTES: Record<string, Route> = { '': 'home', '/': 'home' };

/** Maps `location.hash` (for example "#/") to a route. Anything unlisted is "not-found". */
export function parseRoute(hash: string): Route {
  const path = hash.startsWith('#') ? hash.slice(1) : hash;
  return Object.hasOwn(ROUTES, path) ? (ROUTES[path] as Route) : 'not-found';
}

export const routeHref: Record<Route, string> = { home: '#/', 'not-found': '#/' };
