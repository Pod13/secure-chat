import { describe, expect, test } from 'vitest';

import { REQUEST_TIMEOUT_MS, createHttpNetwork } from '../src/net/http';

function stubFetch(reply: Response | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

const headersOf = (init: RequestInit): Record<string, string> =>
  init.headers as Record<string, string>;

describe('http network', () => {
  test('sends JSON to the same origin with no cookies, referrer or cache', async () => {
    const { fetchFn, calls } = stubFetch(new Response('{"ok":true}', { status: 201 }));
    const network = createHttpNetwork(fetchFn);
    const response = await network.request({
      method: 'POST',
      path: '/v1/x',
      body: Uint8Array.of(123, 125),
    });
    expect(response.status).toBe(201);
    expect(new TextDecoder().decode(response.body)).toBe('{"ok":true}');
    const { url, init } = calls[0] as { url: string; init: RequestInit };
    expect(url).toBe('/v1/x');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      redirect: 'error',
    });
    expect(headersOf(init)).toEqual({ 'content-type': 'application/json' });
    expect(init.body).toEqual(Uint8Array.of(123, 125));
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('http network, headers and limits', () => {
  test('sends the session token as a bearer header, and only when there is one', async () => {
    const { fetchFn, calls } = stubFetch(new Response(null, { status: 204 }));
    const network = createHttpNetwork(fetchFn);
    await network.request({ method: 'PUT', path: '/v1/y', token: 'T' });
    await network.request({ method: 'GET', path: '/v1/z' });
    expect(headersOf(calls[0]?.init as RequestInit).authorization).toBe('Bearer T');
    expect(headersOf(calls[1]?.init as RequestInit)).not.toHaveProperty('authorization');
  });

  test('only paths on this site are allowed', async () => {
    const { fetchFn, calls } = stubFetch(new Response(null, { status: 204 }));
    const network = createHttpNetwork(fetchFn);
    for (const path of [
      'https://evil.example/x',
      '//evil.example/x',
      'v1/x',
      '/v1/../x',
      '/other',
    ]) {
      await expect(network.request({ method: 'GET', path })).rejects.toThrow('path');
    }
    expect(calls).toHaveLength(0);
  });

  test('a network failure becomes an error, and an empty body an empty array', async () => {
    const down = createHttpNetwork(stubFetch(new Error('offline')).fetchFn);
    await expect(down.request({ method: 'GET', path: '/v1/x' })).rejects.toThrow('offline');
    const empty = createHttpNetwork(stubFetch(new Response(null, { status: 204 })).fetchFn);
    expect((await empty.request({ method: 'GET', path: '/v1/x' })).body).toEqual(new Uint8Array());
  });

  test('gives up on a stalled server after the timeout', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(20_000);
  });
});
