// The Recovery Key: a random secret shown once at sign-up. Three independent secrets come from it
// with HKDF-SHA256 and distinct labels: the Account identity key, the Backup encryption key and
// the Backup access token (Constitution III: standard HKDF from WebCrypto, no custom primitives).
// The key is never stored; the identity private half only signs Device certificates.

import type { Random } from '../ports';
import type { Sodium } from './sodium';

const KEY_BYTES = 32;
const CHECK_BYTES = 2;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const GROUP = 5;

/** Distinct HKDF labels; changing one would make existing Recovery Keys unusable. */
export const LABELS = {
  identity: 'secure-chat/recovery/identity-seed/v1',
  backup: 'secure-chat/recovery/backup-key/v1',
  access: 'secure-chat/recovery/backup-access-token/v1',
} as const;

export type RecoveryKeyErrorCode = 'length' | 'characters' | 'checksum';

export class RecoveryKeyError extends Error {
  constructor(readonly code: RecoveryKeyErrorCode) {
    super(code);
    this.name = 'RecoveryKeyError';
  }
}

export interface RecoverySecrets {
  identity: { publicKey: Uint8Array; secretKey: Uint8Array };
  backupKey: Uint8Array;
  accessToken: Uint8Array;
}

/** HKDF-SHA256 (RFC 5869) through WebCrypto. */
export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', ikm.slice(), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt.slice(), info: info.slice() },
    base,
    length * 8,
  );
  return new Uint8Array(bits);
}

export function generateRecoveryKey(random: Random): Uint8Array {
  return random.bytes(KEY_BYTES);
}

function requireLength(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) throw new RecoveryKeyError('length');
}

function checksum(key: Uint8Array, sodium: Sodium): Uint8Array {
  return sodium.sha256(key).slice(0, CHECK_BYTES);
}

function toBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    for (; bits >= 5; bits -= 5) out += ALPHABET[(value >>> (bits - 5)) & 31];
    value &= (1 << bits) - 1;
  }
  // The key and checksum are 34 bytes, which always leaves two bits to flush.
  return out + ALPHABET[(value << (5 - bits)) & 31];
}

function fromBase32(text: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(out);
}

/** The text a person writes down: the key and a short checksum, in groups of five. */
export function formatRecoveryKey(key: Uint8Array, sodium: Sodium): string {
  requireLength(key);
  const text = toBase32(Uint8Array.from([...key, ...checksum(key, sodium)]));
  const groups: string[] = [];
  for (let i = 0; i < text.length; i += GROUP) groups.push(text.slice(i, i + GROUP));
  return groups.join('-');
}

/** Reads what a person typed back; forgives case, spaces and dashes, rejects typos. */
export function parseRecoveryKey(text: string, sodium: Sodium): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s-]/g, '');
  const expected = Math.ceil(((KEY_BYTES + CHECK_BYTES) * 8) / 5);
  if (clean.length !== expected) throw new RecoveryKeyError('length');
  if ([...clean].some((char) => !ALPHABET.includes(char))) throw new RecoveryKeyError('characters');
  const bytes = fromBase32(clean);
  const key = bytes.slice(0, KEY_BYTES);
  const check = bytes.slice(KEY_BYTES, KEY_BYTES + CHECK_BYTES);
  if (!checksum(key, sodium).every((byte, i) => byte === check[i])) {
    throw new RecoveryKeyError('checksum');
  }
  return key;
}

/** The three secrets the Recovery Key stands for. */
export async function deriveRecoverySecrets(
  key: Uint8Array,
  sodium: Sodium,
): Promise<RecoverySecrets> {
  requireLength(key);
  const derive = (label: string): Promise<Uint8Array> =>
    hkdfSha256(key, new Uint8Array(0), new TextEncoder().encode(label), KEY_BYTES);
  return {
    identity: sodium.signingKeyPair(await derive(LABELS.identity)),
    backupKey: await derive(LABELS.backup),
    accessToken: await derive(LABELS.access),
  };
}
