import { beforeAll, describe, expect, test } from 'vitest';

import { MIN_KDF, createSodium, type Sodium } from '../src/crypto/sodium';
import { MAX_PENDING, Outbox, OutboxError } from '../src/net/outbox';
import { webRandom } from '../src/ports';
import { createVault, unlockVault, type Vault } from '../src/store/vault';
import { CountingRandom, MemoryStore } from './fakes';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const PASSCODE = 'correct horse battery';

let sodium: Sodium;
beforeAll(async () => {
  sodium = await createSodium(webRandom);
});

async function fresh(store = new MemoryStore()): Promise<{ vault: Vault; store: MemoryStore }> {
  return { vault: await createVault({ sodium, store, kdf: MIN_KDF }, PASSCODE), store };
}

const idHex = (n: number): string => n.toString(16).padStart(2, '0').repeat(16);

describe('queueing', () => {
  test('keeps messages in the order they were queued, with generated ids', async () => {
    const { vault } = await fresh();
    const outbox = new Outbox(vault, new CountingRandom());
    const first = await outbox.enqueue(text('one'));
    const second = await outbox.enqueue(text('two'));
    expect(first).toBe('000102030405060708090a0b0c0d0e0f');
    expect(second).toBe('101112131415161718191a1b1c1d1e1f');
    expect(
      (await outbox.pending()).map((m) => [m.id, new TextDecoder().decode(m.payload)]),
    ).toEqual([
      [first, 'one'],
      [second, 'two'],
    ]);
  });

  test('queueing the same id twice keeps one copy and the first payload', async () => {
    const { vault } = await fresh();
    const outbox = new Outbox(vault, webRandom);
    await outbox.enqueue(text('first'), idHex(1));
    await outbox.enqueue(text('retry'), idHex(1));
    const pending = await outbox.pending();
    expect(pending.length).toBe(1);
    expect(new TextDecoder().decode(pending[0]?.payload)).toBe('first');
  });

  test('a sent message is removed, and removing an unknown id is harmless', async () => {
    const { vault } = await fresh();
    const outbox = new Outbox(vault, webRandom);
    const a = await outbox.enqueue(text('a'));
    const b = await outbox.enqueue(text('b'));
    await outbox.markSent(a);
    await outbox.markSent(a);
    await outbox.markSent(idHex(9));
    expect((await outbox.pending()).map((m) => m.id)).toEqual([b]);
    expect(await vault.get(`outbox:item:${a}`)).toBeUndefined();
    expect(await vault.get('outbox:index')).toBeDefined();
    await outbox.markSent(b);
    expect(await outbox.pending()).toEqual([]);
  });
});

describe('queueing, limits', () => {
  test('refuses ids that are not 32 lowercase hex characters', async () => {
    const { vault } = await fresh();
    const outbox = new Outbox(vault, webRandom);
    for (const bad of [
      '',
      'abc',
      'g'.repeat(32),
      'A'.repeat(32),
      'a'.repeat(31),
      'a'.repeat(33),
      '../x',
    ]) {
      await expect(outbox.enqueue(text('x'), bad)).rejects.toMatchObject({ code: 'bad_id' });
    }
  });

  test('refuses more than the limit of waiting messages, but frees room when one is sent', async () => {
    const { vault } = await fresh();
    expect(MAX_PENDING).toBe(1000);
    const outbox = new Outbox(vault, webRandom, 3);
    const ids = [1, 2, 3].map(idHex);
    for (const id of ids) await outbox.enqueue(text('x'), id);
    await expect(outbox.enqueue(text('x'), idHex(4))).rejects.toMatchObject({ code: 'full' });
    await outbox.enqueue(text('again'), ids[0]);
    await outbox.markSent(ids[0] as string);
    await outbox.enqueue(text('x'), idHex(4));
    expect((await outbox.pending()).length).toBe(3);
  });
});

describe('storage', () => {
  test('survives a restart: lock, unlock and read again', async () => {
    const { vault, store } = await fresh();
    await new Outbox(vault, webRandom).enqueue(text('keep me'));
    vault.lock();
    const again = await unlockVault({ sodium, store, kdf: MIN_KDF }, PASSCODE);
    const pending = await new Outbox(again, webRandom).pending();
    expect(pending.map((m) => new TextDecoder().decode(m.payload))).toEqual(['keep me']);
  });

  test('puts nothing readable in storage', async () => {
    const { vault, store } = await fresh();
    const id = await new Outbox(vault, webRandom).enqueue(text('planted-outgoing-secret'));
    const planted = text('planted-outgoing-secret');
    for (const [key, value] of store.entries) {
      expect(key.includes(id)).toBe(false);
      const found = value.some((_, i) => planted.every((b, j) => value[i + j] === b));
      expect(found).toBe(false);
    }
  });
});

describe('storage, concurrency and errors', () => {
  test('queueing at the same moment loses nothing', async () => {
    const { vault } = await fresh();
    const outbox = new Outbox(vault, webRandom);
    const ids = await Promise.all(
      Array.from({ length: 20 }, (_, i) => outbox.enqueue(text(`m${i}`))),
    );
    expect((await outbox.pending()).map((m) => m.id).sort()).toEqual([...ids].sort());
  });

  test('a locked vault is an error, and the queue still works afterwards', async () => {
    const { vault, store } = await fresh();
    const outbox = new Outbox(vault, webRandom);
    vault.lock();
    await expect(outbox.enqueue(text('x'))).rejects.toMatchObject({
      name: 'VaultError',
      code: 'locked',
    });
    const reopened = new Outbox(
      await unlockVault({ sodium, store, kdf: MIN_KDF }, PASSCODE),
      webRandom,
    );
    await expect(reopened.enqueue(text('y'))).resolves.toBeDefined();
  });

  test('a message whose record is missing is skipped, not fatal', async () => {
    const { vault } = await fresh();
    const outbox = new Outbox(vault, webRandom);
    const a = await outbox.enqueue(text('a'));
    const b = await outbox.enqueue(text('b'));
    await vault.delete(`outbox:item:${a}`);
    expect((await outbox.pending()).map((m) => m.id)).toEqual([b]);
  });

  test('errors are named', () => {
    expect([new OutboxError('full').name, new OutboxError('full').message]).toEqual([
      'OutboxError',
      'full',
    ]);
  });
});
