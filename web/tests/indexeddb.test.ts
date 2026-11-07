import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, test } from 'vitest';

import { openIndexedDbStore, settle } from '../src/store/indexeddb';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

describe('IndexedDB store', () => {
  test('stores, reads, lists and deletes values', async () => {
    const store = await openIndexedDbStore(new IDBFactory(), 'test');
    expect(await store.get('a')).toBeUndefined();
    await store.put('a', bytes(1, 2));
    await store.put('b', bytes(3));
    expect(await store.get('a')).toEqual(bytes(1, 2));
    expect((await store.keys()).sort()).toEqual(['a', 'b']);
    await store.delete('a');
    expect(await store.get('a')).toBeUndefined();
    expect(await store.keys()).toEqual(['b']);
  });

  test('overwrites an existing value', async () => {
    const store = await openIndexedDbStore(new IDBFactory(), 'test');
    await store.put('a', bytes(1));
    await store.put('a', bytes(2));
    expect(await store.get('a')).toEqual(bytes(2));
  });

  test('keeps data when reopened, and keeps databases with different names apart', async () => {
    const factory = new IDBFactory();
    const first = await openIndexedDbStore(factory, 'one');
    await first.put('a', bytes(9));
    expect(await (await openIndexedDbStore(factory, 'one')).get('a')).toEqual(bytes(9));
    expect(await (await openIndexedDbStore(factory, 'two')).get('a')).toBeUndefined();
  });

  test('returns a copy, so changing the result does not change the stored value', async () => {
    const store = await openIndexedDbStore(new IDBFactory(), 'test');
    const original = bytes(1, 2, 3);
    await store.put('a', original);
    original[0] = 99;
    const read = (await store.get('a')) as Uint8Array;
    read[1] = 99;
    expect(await store.get('a')).toEqual(bytes(1, 2, 3));
  });
});

describe('failures', () => {
  test('settle reports a failed request', async () => {
    const request = {
      onsuccess: null,
      onerror: null,
      error: new Error('boom'),
    } as unknown as IDBRequest;
    const done = settle(request);
    (request.onerror as () => void)();
    await expect(done).rejects.toThrow('boom');
  });

  test('settle reports success', async () => {
    const request = { onsuccess: null, onerror: null, result: 5 } as unknown as IDBRequest<number>;
    const done = settle(request);
    (request.onsuccess as () => void)();
    await expect(done).resolves.toBe(5);
  });

  test('a database that cannot be opened is reported', async () => {
    const factory = {
      open: () => {
        const request = {
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
          error: new Error('denied'),
        };
        queueMicrotask(() => (request.onerror as unknown as () => void)());
        return request;
      },
    } as unknown as IDBFactory;
    await expect(openIndexedDbStore(factory, 'x')).rejects.toThrow('denied');
  });

  test('an unknown failure still produces an error', async () => {
    const request = { onsuccess: null, onerror: null, error: null } as unknown as IDBRequest;
    const done = settle(request);
    (request.onerror as () => void)();
    await expect(done).rejects.toThrow('storage failed');
  });
});
