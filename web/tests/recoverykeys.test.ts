import { beforeAll, describe, expect, test } from 'vitest';

import {
  formatRecoveryKey,
  generateRecoveryKey,
  hkdfSha256,
  parseRecoveryKey,
  deriveRecoverySecrets,
  RecoveryKeyError,
  LABELS,
} from '../src/crypto/recoverykeys';
import { createSodium, type Sodium } from '../src/crypto/sodium';
import type { Random } from '../src/ports';

const fixedRandom = (fill: number): Random => ({ bytes: (n) => new Uint8Array(n).fill(fill) });
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const fromHex = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'hex'));

let sodium: Sodium;
beforeAll(async () => {
  sodium = await createSodium(fixedRandom(7));
});

describe('HKDF-SHA256', () => {
  // RFC 5869 test case 1.
  test('matches the RFC 5869 test vector', async () => {
    const ikm = fromHex('0b'.repeat(22));
    const salt = fromHex('000102030405060708090a0b0c');
    const info = fromHex('f0f1f2f3f4f5f6f7f8f9');
    const okm = await hkdfSha256(ikm, salt, info, 42);
    expect(hex(okm)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });
});

describe('Recovery Key text form', () => {
  test('is 32 random bytes, shown as groups of letters and digits', () => {
    const key = generateRecoveryKey(fixedRandom(1));
    expect(key).toEqual(new Uint8Array(32).fill(1));
    const text = formatRecoveryKey(key, sodium);
    expect(text).toMatch(/^([A-Z2-7]{5}-){10}[A-Z2-7]{5}$/);
  });

  test('round-trips, and forgives case, spaces and dashes', () => {
    const key = generateRecoveryKey({
      bytes: (n) => Uint8Array.from({ length: n }, (_, i) => i * 7),
    });
    const text = formatRecoveryKey(key, sodium);
    expect(parseRecoveryKey(text, sodium)).toEqual(key);
    expect(parseRecoveryKey(text.toLowerCase().replaceAll('-', ' '), sodium)).toEqual(key);
    expect(parseRecoveryKey(text.replaceAll('-', ''), sodium)).toEqual(key);
  });

  test('rejects a mistyped key instead of recovering the wrong account', () => {
    const text = formatRecoveryKey(generateRecoveryKey(fixedRandom(9)), sodium);
    const typo = (text[0] === 'A' ? 'B' : 'A') + text.slice(1);
    expect(() => parseRecoveryKey(typo, sodium)).toThrow(RecoveryKeyError);
    expect(() => parseRecoveryKey(typo, sodium)).toThrow('checksum');
  });

  test('rejects a key whose checksum is only partly wrong', () => {
    const text = formatRecoveryKey(generateRecoveryKey(fixedRandom(9)), sodium);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const last = alphabet.indexOf(text.at(-1) as string);
    const altered = text.slice(0, -1) + alphabet[last ^ 8];
    expect(() => parseRecoveryKey(altered, sodium)).toThrow('checksum');
  });

  test('errors carry their name', () => {
    expect(new RecoveryKeyError('length').name).toBe('RecoveryKeyError');
  });

  test('rejects wrong lengths and characters outside the alphabet', () => {
    const text = formatRecoveryKey(generateRecoveryKey(fixedRandom(9)), sodium);
    expect(() => parseRecoveryKey(text.slice(0, -1), sodium)).toThrow('length');
    expect(() => parseRecoveryKey(`${text}A`, sodium)).toThrow('length');
    expect(() => parseRecoveryKey('1' + text.slice(1), sodium)).toThrow('characters');
    expect(() => parseRecoveryKey('', sodium)).toThrow('length');
  });

  test('refuses to format a key of the wrong size', () => {
    expect(() => formatRecoveryKey(new Uint8Array(31), sodium)).toThrow('length');
  });
});

describe('derived secrets', () => {
  const key = generateRecoveryKey({ bytes: (n) => Uint8Array.from({ length: n }, (_, i) => i) });

  test('give three different values from distinct labels', async () => {
    const secrets = await deriveRecoverySecrets(key, sodium);
    const values = [
      secrets.backupKey,
      secrets.accessToken,
      secrets.identity.secretKey.slice(0, 32),
    ];
    expect(new Set(values.map(hex)).size).toBe(3);
    expect(secrets.backupKey).toHaveLength(32);
    expect(secrets.accessToken).toHaveLength(32);
    expect(secrets.identity.publicKey).toHaveLength(32);
    expect(Object.values(LABELS)).toHaveLength(3);
    expect(new Set(Object.values(LABELS)).size).toBe(3);
  });

  test('are the same every time for the same key, and different for another key', async () => {
    const a = await deriveRecoverySecrets(key, sodium);
    const b = await deriveRecoverySecrets(key, sodium);
    const other = await deriveRecoverySecrets(fixedRandom(5).bytes(32), sodium);
    expect(hex(a.identity.publicKey)).toBe(hex(b.identity.publicKey));
    expect(hex(a.backupKey)).toBe(hex(b.backupKey));
    expect(hex(a.accessToken)).toBe(hex(b.accessToken));
    expect(hex(a.identity.publicKey)).not.toBe(hex(other.identity.publicKey));
    expect(hex(a.backupKey)).not.toBe(hex(other.backupKey));
  });

  test('derive an identity key that can sign and be verified', async () => {
    const { identity } = await deriveRecoverySecrets(key, sodium);
    const message = new TextEncoder().encode('hello');
    const signature = sodium.signDetached(identity.secretKey, message);
    expect(sodium.verifyDetached(signature, message, identity.publicKey)).toBe(true);
  });

  test('refuse a key of the wrong size', async () => {
    await expect(deriveRecoverySecrets(new Uint8Array(16), sodium)).rejects.toThrow('length');
  });
});
