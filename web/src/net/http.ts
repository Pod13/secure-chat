// The real network port: `fetch` to this site's own API and nothing else. No cookies, no
// referrer, no caching and no redirects, so a request can only go where the app meant it to.

import type { HttpRequest, HttpResponse, Network } from '../ports';

export const REQUEST_TIMEOUT_MS = 20_000;

/** Only API paths on this origin, with no dot segments. */
const API_PATH = /^\/v1\/[A-Za-z0-9/_-]*$/;

export function createHttpNetwork(fetchFn: typeof fetch = fetch): Network {
  return {
    async request(request: HttpRequest): Promise<HttpResponse> {
      if (!API_PATH.test(request.path)) throw new Error('refused path');
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (request.token !== undefined) headers.authorization = `Bearer ${request.token}`;
      const response = await fetchFn(request.path, {
        method: request.method,
        headers,
        body: request.body?.slice() ?? null,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return { status: response.status, body: new Uint8Array(await response.arrayBuffer()) };
    },
  };
}
