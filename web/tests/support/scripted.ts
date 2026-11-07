// A relay that answers by path, so tests do not depend on the order requests are made in (the
// socket and the screens log in and call the API at the same time).

import { toBase64Url } from '../../src/net/base64';
import type { HttpRequest, HttpResponse, Network } from '../../src/ports';

export const json = (value: unknown, status = 200): HttpResponse => ({
  status,
  body: new TextEncoder().encode(JSON.stringify(value)),
});

export const bodyJson = (request: HttpRequest): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown>;

export class ScriptedNetwork implements Network {
  readonly requests: HttpRequest[] = [];
  readonly routes = new Map<string, (request: HttpRequest) => HttpResponse>();

  constructor() {
    this.routes.set('POST /v1/auth/challenge', () =>
      json({ nonce: toBase64Url(new Uint8Array(32).fill(1)) }),
    );
    this.routes.set('POST /v1/auth/token', () => json({ token: 'T'.repeat(43), expires_in: 900 }));
  }

  on(route: string, reply: (request: HttpRequest) => HttpResponse): this {
    this.routes.set(route, reply);
    return this;
  }

  request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const reply = this.routes.get(`${request.method} ${request.path}`);
    return Promise.resolve(reply === undefined ? json({ error: 'unrouted' }, 404) : reply(request));
  }

  to(route: string): HttpRequest[] {
    return this.requests.filter((r) => `${r.method} ${r.path}` === route);
  }
}
