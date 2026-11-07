import { beforeAll, describe, expect, test } from 'vitest';

import { CryptoError, DEFAULT_KDF, MIN_KDF, createSodium, type Sodium } from '../src/crypto/sodium';
import { webRandom } from '../src/ports';
import { CountingRandom } from './fakes';

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));
const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

let sodium: Sodium;
beforeAll(async () => {
  sodium = await createSodium(webRandom);
});

const key = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

function code(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof CryptoError ? error.code : 'other';
  }
  return undefined;
}

describe('XChaCha20-Poly1305 sealing', () => {
  test('matches the published test vector (draft-irtf-cfrg-xchacha A.3.1)', async () => {
    const nonce = fromHex('404142434445464748494a4b4c4d4e4f5051525354555657');
    const fixed = await createSodium({ bytes: (n) => (n === 24 ? nonce : new Uint8Array(n)) });
    const sealed = fixed.seal(
      fromHex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f'),
      new TextEncoder().encode(
        "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
      ),
      fromHex('50515253c0c1c2c3c4c5c6c7'),
    );
    expect(toHex(sealed.slice(0, 24))).toBe(toHex(nonce));
    expect(toHex(sealed.slice(24, 24 + 16))).toBe('bd6d179d3e83d43b9576579493c0e939');
    expect(toHex(sealed.slice(-16))).toBe('c0875924c1c7987947deafd8780acf49');
  });

  test('round-trips, with and without associated data', () => {
    const data = new TextEncoder().encode('hello');
    expect(sodium.open(key(1), sodium.seal(key(1), data))).toEqual(data);
    const aad = new Uint8Array([9, 9]);
    expect(sodium.open(key(1), sodium.seal(key(1), data, aad), aad)).toEqual(data);
    expect(sodium.open(key(1), sodium.seal(key(1), new Uint8Array()))).toEqual(new Uint8Array());
  });

  test('output is nonce (24) + data + tag (16), nonce taken from the injected random', async () => {
    const counting = await createSodium(new CountingRandom());
    const sealed = counting.seal(key(1), new Uint8Array(5));
    expect(sealed.length).toBe(24 + 5 + 16);
    expect([...sealed.slice(0, 24)]).toEqual([...Array(24).keys()]);
  });
});

describe('XChaCha20-Poly1305 sealing, bad input', () => {
  test('two seals of the same data differ', () => {
    const a = sodium.seal(key(1), new Uint8Array(8));
    const b = sodium.seal(key(1), new Uint8Array(8));
    expect(toHex(a)).not.toBe(toHex(b));
  });

  test('the wrong key, wrong associated data or any changed byte is refused', () => {
    const sealed = sodium.seal(key(1), new TextEncoder().encode('secret'), new Uint8Array([1]));
    expect(code(() => sodium.open(key(2), sealed, new Uint8Array([1])))).toBe('decrypt_failed');
    expect(code(() => sodium.open(key(1), sealed, new Uint8Array([2])))).toBe('decrypt_failed');
    expect(code(() => sodium.open(key(1), sealed))).toBe('decrypt_failed');
    for (let i = 0; i < sealed.length; i += 1) {
      const changed = sealed.slice();
      changed[i] = (changed[i] ?? 0) ^ 1;
      expect(code(() => sodium.open(key(1), changed, new Uint8Array([1])))).toBe('decrypt_failed');
    }
  });

  test('input too short to hold a nonce and tag is refused', () => {
    expect(code(() => sodium.open(key(1), new Uint8Array(39)))).toBe('malformed');
    expect(code(() => sodium.open(key(1), new Uint8Array(40)))).toBe('decrypt_failed');
  });

  test('keys of the wrong length are refused', () => {
    expect(code(() => sodium.seal(new Uint8Array(31), new Uint8Array()))).toBe('bad_key');
    expect(code(() => sodium.seal(new Uint8Array(33), new Uint8Array()))).toBe('bad_key');
    expect(code(() => sodium.open(new Uint8Array(16), new Uint8Array(60)))).toBe('bad_key');
  });

  test('random keys are 32 bytes and come from the injected random', async () => {
    const counting = await createSodium(new CountingRandom());
    expect([...counting.randomKey()]).toEqual([...Array(32).keys()]);
    expect(sodium.randomKey().length).toBe(32);
  });
});

test('crypto errors are named and carry only their code', () => {
  const error = new CryptoError('bad_key');
  expect([error.name, error.message, error.code]).toEqual(['CryptoError', 'bad_key', 'bad_key']);
});

describe('Argon2id passcode keys', () => {
  test('the cost settings are the documented ones', () => {
    expect(MIN_KDF).toEqual({ opslimit: 2, memlimit: 19 * 1024 * 1024 });
    expect(DEFAULT_KDF).toEqual({ opslimit: 3, memlimit: 64 * 1024 * 1024 });
  });

  const salt = new Uint8Array(16).fill(7);

  test('the same passcode and salt give the same 32-byte key', () => {
    const a = sodium.deriveKey('correct horse', salt, MIN_KDF);
    expect(a.length).toBe(32);
    expect(toHex(sodium.deriveKey('correct horse', salt, MIN_KDF))).toBe(toHex(a));
  });

  test('a different passcode, salt or cost gives a different key', () => {
    const base = toHex(sodium.deriveKey('correct horse', salt, MIN_KDF));
    expect(toHex(sodium.deriveKey('correct horsf', salt, MIN_KDF))).not.toBe(base);
    expect(toHex(sodium.deriveKey('correct horse', new Uint8Array(16).fill(8), MIN_KDF))).not.toBe(
      base,
    );
    const costlier = { ...MIN_KDF, opslimit: MIN_KDF.opslimit + 1 };
    expect(toHex(sodium.deriveKey('correct horse', salt, costlier))).not.toBe(base);
  });

  test('visually identical passcodes (composed and decomposed accents) give the same key', () => {
    const composed = sodium.deriveKey('café au lait', salt, MIN_KDF);
    const decomposed = sodium.deriveKey('café au lait', salt, MIN_KDF);
    expect(toHex(composed)).toBe(toHex(decomposed));
  });

  test('a salt of the wrong length is refused', () => {
    expect(code(() => sodium.deriveKey('x', new Uint8Array(15), MIN_KDF))).toBe('bad_salt');
    expect(code(() => sodium.deriveKey('x', new Uint8Array(17), MIN_KDF))).toBe('bad_salt');
  });

  test('settings weaker than the minimum are refused, one limit at a time', () => {
    const weakOps = { ...MIN_KDF, opslimit: MIN_KDF.opslimit - 1 };
    const weakMem = { ...MIN_KDF, memlimit: MIN_KDF.memlimit - 1 };
    expect(code(() => sodium.deriveKey('x', salt, weakOps))).toBe('weak_kdf');
    expect(code(() => sodium.deriveKey('x', salt, weakMem))).toBe('weak_kdf');
  });

  test('new salts are 16 bytes from the injected random', async () => {
    const counting = await createSodium(new CountingRandom());
    expect([...counting.newSalt()]).toEqual([...Array(16).keys()]);
  });
});

describe('keyed hash', () => {
  const text = new TextEncoder().encode('contact-42');

  test('is 16 bytes and repeatable for the same key and data', () => {
    const a = sodium.keyedHash(key(1), text);
    expect(a.length).toBe(16);
    expect(toHex(sodium.keyedHash(key(1), text))).toBe(toHex(a));
  });

  test('changes with the key and with the data', () => {
    const base = toHex(sodium.keyedHash(key(1), text));
    expect(toHex(sodium.keyedHash(key(2), text))).not.toBe(base);
    expect(toHex(sodium.keyedHash(key(1), new TextEncoder().encode('contact-43')))).not.toBe(base);
  });

  test('a key of the wrong length is refused', () => {
    expect(code(() => sodium.keyedHash(new Uint8Array(31), text))).toBe('bad_key');
  });
});
