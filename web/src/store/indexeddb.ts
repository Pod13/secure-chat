// The browser's IndexedDB as a plain key-value store. Everything given to it is already sealed by
// the vault, so this layer sees only ciphertext and hashed names (Constitution II).

import type { KeyValueStore } from '../ports';

const STORE = 'kv';

/** Turns an IndexedDB request into a promise. */
export function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('storage failed'));
  });
}

function open(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  const request = factory.open(name, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE);
  return settle(request);
}

export async function openIndexedDbStore(
  factory: IDBFactory,
  name = 'secure-chat',
): Promise<KeyValueStore> {
  const db = await open(factory, name);
  const objects = (mode: IDBTransactionMode): IDBObjectStore =>
    db.transaction(STORE, mode).objectStore(STORE);
  return {
    async get(key) {
      const found = (await settle(objects('readonly').get(key))) as Uint8Array | undefined;
      return found === undefined ? undefined : found.slice();
    },
    async put(key, value) {
      await settle(objects('readwrite').put(value.slice(), key));
    },
    async delete(key) {
      await settle(objects('readwrite').delete(key));
    },
    async keys() {
      return (await settle(objects('readonly').getAllKeys())).map(String);
    },
  };
}
