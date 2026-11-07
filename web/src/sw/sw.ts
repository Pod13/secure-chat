// Service worker entry: connects the browser's fetch events to the rules in `guard.ts`. It holds
// no decisions of its own, so it is covered by the end-to-end tests (Scenario 6) rather than by
// unit tests. Built as a separate file so the worker has a stable URL.

import { createSodium } from '../crypto/sodium';
import type { KeyValueStore } from '../ports';
import { webRandom } from '../ports';
import { Guard, type NetResponse } from './guard';
import { parseKeys } from './trustedKeys';

// Replaced by the build (vite.config.ts) with the pinned public keys.
declare const __RELEASE_PUBLIC_KEYS__: string;
const TRUSTED_KEYS = parseKeys(__RELEASE_PUBLIC_KEYS__);

// The worker global, typed for the few members used here.
interface WorkerScope {
  addEventListener(type: string, listener: (event: never) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  location: { origin: string };
}
interface FetchEventLike {
  request: { method: string; url: string };
  respondWith(response: Promise<Response>): void;
}
interface WaitEvent {
  waitUntil(work: Promise<unknown>): void;
}

const scope = self as unknown as WorkerScope;
const API_PREFIX = '/v1/';
const STATE_CACHE = 'sw-state';

const stateStore: KeyValueStore = {
  async get(key) {
    const hit = await (await caches.open(STATE_CACHE)).match(`/__state/${key}`);
    return hit === undefined ? undefined : new Uint8Array(await hit.arrayBuffer());
  },
  async put(key, value) {
    await (await caches.open(STATE_CACHE)).put(`/__state/${key}`, new Response(value.slice()));
  },
  async delete(key) {
    await (await caches.open(STATE_CACHE)).delete(`/__state/${key}`);
  },
  async keys() {
    const requests = await (await caches.open(STATE_CACHE)).keys();
    return requests.map((r) => new URL(r.url).pathname.replace('/__state/', ''));
  },
};

async function network(path: string): Promise<NetResponse> {
  const response = await fetch(`/${path}`, { cache: 'no-store' });
  return {
    status: response.status,
    body: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') ?? 'application/octet-stream',
  };
}

const guardPromise = createSodium(webRandom).then(async (sodium) => {
  const guard = new Guard({
    crypto: { sha256: sodium.sha256, verify: sodium.verifyDetached },
    trustedKeys: TRUSTED_KEYS,
    network,
    store: stateStore,
  });
  await guard.load();
  return guard;
});

const WARNING =
  '<!doctype html><meta charset="utf-8"><title>Cannot verify app</title>' +
  '<h1>This app could not be verified</h1><p>Its files do not match the signed release, so it was ' +
  'not started to protect your messages. Check your network, or reinstall from the official address.</p>';

async function respond(url: string): Promise<Response> {
  const guard = await guardPromise;
  const result = await guard.serve(new URL(url).pathname);
  if (result.ok)
    return new Response(result.body.slice(), { headers: { 'content-type': result.contentType } });
  return new Response(WARNING, {
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

scope.addEventListener('install', (event: WaitEvent) => event.waitUntil(scope.skipWaiting()));
scope.addEventListener('activate', (event: WaitEvent) => event.waitUntil(scope.clients.claim()));
scope.addEventListener('fetch', (event: FetchEventLike) => {
  const url = new URL(event.request.url);
  const mine = url.origin === scope.location.origin && event.request.method === 'GET';
  if (mine && !url.pathname.startsWith(API_PREFIX)) event.respondWith(respond(event.request.url));
});
