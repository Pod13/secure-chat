// libsodium helpers: Argon2id passcode keys and XChaCha20-Poly1305 sealing (Constitution III:
// no custom cryptography, only these audited primitives). Randomness comes from the injected
// `Random` port so tests can control it.

import sodiumLib from 'libsodium-wrappers-sumo';

import type { Random } from '../ports';

const KEY_BYTES = 32;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const HASH_BYTES = 16;

export interface KdfParams {
  /** Argon2id passes. */
  opslimit: number;
  /** Argon2id memory in bytes. */
  memlimit: number;
}

/** The weakest Argon2id setting accepted (OWASP minimum: 19 MiB, 2 passes). */
export const MIN_KDF: KdfParams = { opslimit: 2, memlimit: 19 * 1024 * 1024 };

/** Used for real passcodes; the vault tunes this to about 500 ms on a mid-range phone (R4). */
export const DEFAULT_KDF: KdfParams = { opslimit: 3, memlimit: 64 * 1024 * 1024 };

export type CryptoErrorCode = 'bad_key' | 'bad_salt' | 'weak_kdf' | 'malformed' | 'decrypt_failed';

export class CryptoError extends Error {
  constructor(readonly code: CryptoErrorCode) {
    super(code);
    this.name = 'CryptoError';
  }
}

export interface Sodium {
  /** 32 random bytes. */
  randomKey(): Uint8Array;
  /** 16 random bytes for Argon2id. */
  newSalt(): Uint8Array;
  /** Argon2id key from a passcode (Unicode-normalised so equal-looking passcodes match). */
  deriveKey(passcode: string, salt: Uint8Array, params?: KdfParams): Uint8Array;
  /** 16-byte keyed BLAKE2b hash: a stable label that reveals nothing about `data` without the key. */
  keyedHash(key: Uint8Array, data: Uint8Array): Uint8Array;
  /** Returns nonce || ciphertext || tag. */
  seal(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Uint8Array;
  /** Reverses `seal`; throws `CryptoError` for anything that does not authenticate. */
  open(key: Uint8Array, sealed: Uint8Array, aad?: Uint8Array): Uint8Array;
}

function requireKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) throw new CryptoError('bad_key');
}

export async function createSodium(random: Random): Promise<Sodium> {
  await sodiumLib.ready;
  const lib = sodiumLib;

  return {
    randomKey: () => random.bytes(KEY_BYTES),
    newSalt: () => random.bytes(SALT_BYTES),

    deriveKey(passcode, salt, params = DEFAULT_KDF) {
      if (salt.length !== SALT_BYTES) throw new CryptoError('bad_salt');
      if (params.opslimit < MIN_KDF.opslimit || params.memlimit < MIN_KDF.memlimit) {
        throw new CryptoError('weak_kdf');
      }
      return lib.crypto_pwhash(
        KEY_BYTES,
        passcode.normalize('NFKC'),
        salt,
        params.opslimit,
        params.memlimit,
        lib.crypto_pwhash_ALG_ARGON2ID13,
      );
    },

    keyedHash(key, data) {
      requireKey(key);
      return lib.crypto_generichash(HASH_BYTES, data, key);
    },

    seal(key, plaintext, aad = new Uint8Array()) {
      requireKey(key);
      const nonce = random.bytes(NONCE_BYTES);
      const body = lib.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, null, nonce, key);
      const out = new Uint8Array(NONCE_BYTES + body.length);
      out.set(nonce);
      out.set(body, NONCE_BYTES);
      return out;
    },

    open(key, sealed, aad = new Uint8Array()) {
      requireKey(key);
      if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new CryptoError('malformed');
      try {
        return lib.crypto_aead_xchacha20poly1305_ietf_decrypt(
          null,
          sealed.slice(NONCE_BYTES),
          aad,
          sealed.slice(0, NONCE_BYTES),
          key,
        );
      } catch {
        throw new CryptoError('decrypt_failed');
      }
    },
  };
}
