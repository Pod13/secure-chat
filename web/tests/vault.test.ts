import { beforeAll, describe, expect, test } from 'vitest';

import { MIN_KDF, createSodium, type Sodium } from '../src/crypto/sodium';
import { webRandom } from '../src/ports';
import {
  MIN_PASSCODE_LENGTH,
  VaultError,
  createVault,
  unlockVault,
  type VaultDeps,
  costIsSane,
} from '../src/store/vault';
import { MemoryStore } from './fakes';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const PASSCODE = 'correct horse battery';

let sodium: Sodium;
beforeAll(async () => {
  sodium = await createSodium(webRandom);
});

const deps = (store = new MemoryStore()): VaultDeps & { store: MemoryStore } => ({
  sodium,
  store,
  kdf: MIN_KDF,
});

async function codeOf(action: () => unknown): Promise<string | undefined> {
  try {
    await action();
  } catch (error) {
    return error instanceof VaultError ? error.code : 'other';
  }
  return undefined;
}

describe('creating a vault', () => {
  test('stores and returns records', async () => {
    const vault = await createVault(deps(), PASSCODE);
    await vault.put('profile', text('hello'));
    expect(await vault.get('profile')).toEqual(text('hello'));
    expect(await vault.get('missing')).toBeUndefined();
  });

  test('a record can be replaced and deleted', async () => {
    const vault = await createVault(deps(), PASSCODE);
    await vault.put('a', text('one'));
    await vault.put('a', text('two'));
    expect(await vault.get('a')).toEqual(text('two'));
    await vault.delete('a');
    expect(await vault.get('a')).toBeUndefined();
  });

  test('refuses a short passcode, counting characters rather than bytes', async () => {
    expect(MIN_PASSCODE_LENGTH).toBe(10);
    const short = 'x'.repeat(MIN_PASSCODE_LENGTH - 1);
    expect(await codeOf(() => createVault(deps(), short))).toBe('passcode_too_short');
    expect(await codeOf(() => createVault(deps(), 'é'.repeat(MIN_PASSCODE_LENGTH - 1)))).toBe(
      'passcode_too_short',
    );
    expect(
      await codeOf(() => createVault(deps(), 'x'.repeat(MIN_PASSCODE_LENGTH))),
    ).toBeUndefined();
  });

  test('refuses to overwrite an existing vault', async () => {
    const d = deps();
    await createVault(d, PASSCODE);
    expect(await codeOf(() => createVault(d, PASSCODE))).toBe('exists');
  });
});

describe('unlocking', () => {
  test('the right passcode reads earlier records', async () => {
    const d = deps();
    const first = await createVault(d, PASSCODE);
    await first.put('note', text('kept'));
    first.lock();
    const again = await unlockVault(d, PASSCODE);
    expect(await again.get('note')).toEqual(text('kept'));
  });

  test('a wrong passcode is refused', async () => {
    const d = deps();
    await createVault(d, PASSCODE);
    expect(await codeOf(() => unlockVault(d, PASSCODE + 'x'))).toBe('wrong_passcode');
  });

  test('no vault means nothing to unlock', async () => {
    expect(await codeOf(() => unlockVault(deps(), PASSCODE))).toBe('no_vault');
  });

  test('a damaged header is reported as corrupt, not as a wrong passcode', async () => {
    const d = deps();
    await createVault(d, PASSCODE);
    const meta = d.store.entries.get('meta') as Uint8Array;
    for (const broken of [
      meta.slice(0, 20),
      new Uint8Array(0),
      Uint8Array.from([2, ...meta.slice(1)]),
    ]) {
      d.store.entries.set('meta', broken);
      expect(await codeOf(() => unlockVault(d, PASSCODE))).toBe('corrupt');
    }
  });
});

describe('unlocking, damaged headers', () => {
  test('cost settings that are weak or absurdly large are corrupt', async () => {
    const d = deps();
    await createVault(d, PASSCODE);
    const meta = d.store.entries.get('meta') as Uint8Array;
    const withCost = (ops: number, mem: number): Uint8Array => {
      const copy = meta.slice();
      const view = new DataView(copy.buffer);
      view.setUint32(1, ops);
      view.setUint32(5, mem);
      return copy;
    };
    for (const [ops, mem] of [
      [1, MIN_KDF.memlimit],
      [MIN_KDF.opslimit, MIN_KDF.memlimit - 1],
      [21, MIN_KDF.memlimit],
      [MIN_KDF.opslimit, 1024 * 1024 * 1024 + 1],
    ] as const) {
      d.store.entries.set('meta', withCost(ops, mem));
      expect(await codeOf(() => unlockVault(d, PASSCODE))).toBe('corrupt');
    }
  });

  test('any changed byte in the header or wrapped key stops unlocking', async () => {
    const d = deps();
    await createVault(d, PASSCODE);
    const meta = d.store.entries.get('meta') as Uint8Array;
    for (const i of [9, 24, 25, meta.length - 1]) {
      const copy = meta.slice();
      copy[i] = (copy[i] ?? 0) ^ 1;
      d.store.entries.set('meta', copy);
      expect(await codeOf(() => unlockVault(d, PASSCODE))).toBeDefined();
    }
  });
});

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    if (needle.every((byte, j) => haystack[i + j] === byte)) return true;
  }
  return false;
}

describe('what is in storage', () => {
  test('labels have a fixed length whatever the name', async () => {
    const d = deps();
    const vault = await createVault(d, PASSCODE);
    for (let i = 0; i < 60; i += 1) await vault.put(`name-${i}`, text('v'));
    for (const key of d.store.entries.keys()) {
      if (key !== 'meta') expect(key).toMatch(/^r:[0-9a-f]{32}$/);
    }
  });

  test('holds no readable data, names or passcode', async () => {
    const d = deps();
    const vault = await createVault(d, PASSCODE);
    const secret = 'planted-secret-value-1234';
    await vault.put('contact-alice', text(secret));
    for (const [name, value] of d.store.entries) {
      for (const planted of [secret, 'contact-alice', 'alice', PASSCODE]) {
        expect(contains(value, text(planted)), `${name} contains ${planted}`).toBe(false);
        expect(name.includes(planted)).toBe(false);
      }
    }
  });

  test('record names are hidden but stable', async () => {
    const d = deps();
    const vault = await createVault(d, PASSCODE);
    await vault.put('same', text('1'));
    const before = [...d.store.entries.keys()].sort();
    await vault.put('same', text('2'));
    expect([...d.store.entries.keys()].sort()).toEqual(before);
    await vault.put('other', text('3'));
    expect(d.store.entries.size).toBe(before.length + 1);
  });
});

describe('what is in storage, tampering', () => {
  test('two vaults with the same passcode share no keys, salts or record labels', async () => {
    const a = deps();
    const b = deps();
    const vaultA = await createVault(a, PASSCODE);
    const vaultB = await createVault(b, PASSCODE);
    await vaultA.put('x', text('1'));
    await vaultB.put('x', text('1'));
    expect([...a.store.entries.keys()].sort()).not.toEqual([...b.store.entries.keys()].sort());
    expect(a.store.entries.get('meta')).not.toEqual(b.store.entries.get('meta'));
  });

  test('a changed record is refused rather than returned', async () => {
    const d = deps();
    const vault = await createVault(d, PASSCODE);
    await vault.put('note', text('original'));
    const label = [...d.store.entries.keys()].find((k) => k !== 'meta') as string;
    const value = d.store.entries.get(label) as Uint8Array;
    value[value.length - 1] = (value[value.length - 1] ?? 0) ^ 1;
    expect(await codeOf(() => vault.get('note'))).toBe('corrupt');
  });

  test('a record moved to another name is refused', async () => {
    const d = deps();
    const vault = await createVault(d, PASSCODE);
    await vault.put('cheap', text('1'));
    await vault.put('valuable', text('2'));
    const labels = [...d.store.entries.keys()].filter((k) => k !== 'meta');
    const [first, second] = labels as [string, string];
    const swapped = d.store.entries.get(first) as Uint8Array;
    d.store.entries.set(second, swapped);
    d.store.entries.set(first, d.store.entries.get(second) as Uint8Array);
    const results = await Promise.all([
      codeOf(() => vault.get('cheap')),
      codeOf(() => vault.get('valuable')),
    ]);
    expect(results).toContain('corrupt');
  });
});

describe('locking and wiping', () => {
  test('locking twice is harmless and errors are named', async () => {
    const vault = await createVault(deps(), PASSCODE);
    vault.lock();
    expect(() => vault.lock()).not.toThrow();
    expect(new VaultError('locked').name).toBe('VaultError');
    expect(new VaultError('locked').message).toBe('locked');
  });

  test('a locked vault refuses every operation', async () => {
    const vault = await createVault(deps(), PASSCODE);
    await vault.put('a', text('1'));
    expect(vault.isLocked).toBe(false);
    vault.lock();
    expect(vault.isLocked).toBe(true);
    expect(await codeOf(() => vault.get('a'))).toBe('locked');
    expect(await codeOf(() => vault.put('a', text('2')))).toBe('locked');
    expect(await codeOf(() => vault.delete('a'))).toBe('locked');
  });

  test('wipe removes every stored entry and locks', async () => {
    const d = deps();
    const vault = await createVault(d, PASSCODE);
    await vault.put('a', text('1'));
    await vault.put('b', text('2'));
    await vault.wipe();
    expect(d.store.entries.size).toBe(0);
    expect(vault.isLocked).toBe(true);
    expect(await codeOf(() => unlockVault(d, PASSCODE))).toBe('no_vault');
  });

  test('locking erases the data key from memory', async () => {
    const seen: Uint8Array[] = [];
    const spy: Sodium = {
      ...sodium,
      seal: (k, p, a) => {
        seen.push(k);
        return sodium.seal(k, p, a);
      },
    };
    const d = { ...deps(), sodium: spy };
    const vault = await createVault(d, PASSCODE);
    await vault.put('a', text('1'));
    const dataKey = seen[seen.length - 1] as Uint8Array;
    expect(dataKey.some((b) => b !== 0)).toBe(true);
    vault.lock();
    expect(dataKey.every((b) => b === 0)).toBe(true);
  });
});

describe('boundaries', () => {
  test('a header that is just long enough is read, and fails as a wrong passcode', async () => {
    const d = deps();
    await createVault(d, PASSCODE);
    const meta = d.store.entries.get('meta') as Uint8Array;
    d.store.entries.set('meta', meta.slice(0, 65));
    expect(await codeOf(() => unlockVault(d, PASSCODE))).toBe('wrong_passcode');
  });

  test('new vaults use the default cost when none is given', async () => {
    const d = { sodium, store: new MemoryStore() };
    await createVault(d, PASSCODE);
    const meta = d.store.entries.get('meta') as Uint8Array;
    const view = new DataView(meta.buffer, meta.byteOffset);
    expect([view.getUint32(1), view.getUint32(5)]).toEqual([3, 64 * 1024 * 1024]);
  });
});

describe('cost limits', () => {
  test('are inclusive at the documented ceilings', () => {
    expect(costIsSane({ opslimit: 20, memlimit: 1024 * 1024 * 1024 })).toBe(true);
    expect(costIsSane({ opslimit: 21, memlimit: 1024 * 1024 * 1024 })).toBe(false);
    expect(costIsSane({ opslimit: 20, memlimit: 1024 * 1024 * 1024 + 1 })).toBe(false);
  });
});
