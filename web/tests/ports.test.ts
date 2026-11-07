import { expect, test } from 'vitest';

import { systemClock, webRandom } from '../src/ports';
import { CountingRandom, FakeClock, FakeNetwork, MemoryStore } from './fakes';

test('the fake clock moves only when told', () => {
  const clock = new FakeClock(1_000);
  clock.advance(30);
  expect(clock.nowMs()).toBe(1_030);
});

test('the counting random is predictable and continues across calls', () => {
  const random = new CountingRandom();
  expect([...random.bytes(3)]).toEqual([0, 1, 2]);
  expect([...random.bytes(2)]).toEqual([3, 4]);
});

test('the memory store behaves like a key-value store', async () => {
  const store = new MemoryStore();
  await store.put('a', new Uint8Array([1]));
  expect(await store.get('a')).toEqual(new Uint8Array([1]));
  expect(await store.keys()).toEqual(['a']);
  await store.delete('a');
  expect(await store.get('a')).toBeUndefined();
});

test('the fake network answers in order, records requests and then runs dry', async () => {
  const net = new FakeNetwork([{ status: 200, body: new Uint8Array([7]) }]);
  const response = await net.request({ method: 'GET', path: '/healthz' });
  expect(response.status).toBe(200);
  expect(net.requests).toEqual([{ method: 'GET', path: '/healthz' }]);
  await expect(net.request({ method: 'GET', path: '/x' })).rejects.toThrow('no response queued');
});

test('the real clock reports a plausible time', () => {
  expect(systemClock.nowMs()).toBeGreaterThan(1_767_225_600_000);
});

test('the real random returns the requested length and differs between calls', () => {
  const a = webRandom.bytes(32);
  const b = webRandom.bytes(32);
  expect(a).toHaveLength(32);
  expect(a).not.toEqual(b);
});
