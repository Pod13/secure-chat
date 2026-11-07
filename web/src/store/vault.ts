// The encrypted local vault (research R4, FR-040). A random data key encrypts every record; the
// data key itself is stored only wrapped by an Argon2id key made from the passcode. Record names
// are replaced by keyed hashes so storage shows neither content nor names. Everything here is
// pure logic over the injected sodium helpers and key-value store.

import { DEFAULT_KDF, type KdfParams, type Sodium } from '../crypto/sodium';
import type { KeyValueStore } from '../ports';

export const MIN_PASSCODE_LENGTH = 10;

const META_KEY = 'meta';
const RECORD_PREFIX = 'r:';
const VERSION = 1;
const SALT_BYTES = 16;
const HEADER_BYTES = 1 + 4 + 4 + SALT_BYTES;
/** Settings read back from storage above these are treated as damage, not honoured. */
const MAX_OPSLIMIT = 20;
const MAX_MEMLIMIT = 1024 * 1024 * 1024;

export type VaultErrorCode =
  'passcode_too_short' | 'exists' | 'no_vault' | 'wrong_passcode' | 'corrupt' | 'locked';

export class VaultError extends Error {
  constructor(readonly code: VaultErrorCode) {
    super(code);
    this.name = 'VaultError';
  }
}

export interface VaultDeps {
  sodium: Sodium;
  store: KeyValueStore;
  /** Argon2id cost for new vaults. Tests lower it to the allowed minimum. */
  kdf?: KdfParams;
}

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function header(kdf: KdfParams, salt: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES);
  const view = new DataView(out.buffer);
  out[0] = VERSION;
  view.setUint32(1, kdf.opslimit);
  view.setUint32(5, kdf.memlimit);
  out.set(salt, 9);
  return out;
}

/** Settings read from storage must not let a tampered header demand huge memory or time. */
export function costIsSane(kdf: KdfParams): boolean {
  return kdf.opslimit <= MAX_OPSLIMIT && kdf.memlimit <= MAX_MEMLIMIT;
}

function parseHeader(meta: Uint8Array): { kdf: KdfParams; salt: Uint8Array } {
  if (meta[0] !== VERSION) throw new RangeError();
  const view = new DataView(meta.buffer, meta.byteOffset, meta.byteLength);
  const kdf = { opslimit: view.getUint32(1), memlimit: view.getUint32(5) };
  if (!costIsSane(kdf)) throw new RangeError();
  return { kdf, salt: meta.slice(9, HEADER_BYTES) };
}

export class Vault {
  private dataKey: Uint8Array | undefined;

  constructor(
    private readonly deps: VaultDeps,
    dataKey: Uint8Array,
  ) {
    this.dataKey = dataKey;
  }

  get isLocked(): boolean {
    return this.dataKey === undefined;
  }

  private key(): Uint8Array {
    if (this.dataKey === undefined) throw new VaultError('locked');
    return this.dataKey;
  }

  private label(name: string): string {
    return RECORD_PREFIX + hex(this.deps.sodium.keyedHash(this.key(), encode(name)));
  }

  async put(name: string, value: Uint8Array): Promise<void> {
    const sealed = this.deps.sodium.seal(this.key(), value, encode(name));
    await this.deps.store.put(this.label(name), sealed);
  }

  async get(name: string): Promise<Uint8Array | undefined> {
    const key = this.key();
    const sealed = await this.deps.store.get(this.label(name));
    if (sealed === undefined) return undefined;
    try {
      return this.deps.sodium.open(key, sealed, encode(name));
    } catch {
      // `open` fails only when the record does not authenticate.
      throw new VaultError('corrupt');
    }
  }

  async delete(name: string): Promise<void> {
    await this.deps.store.delete(this.label(name));
  }

  /** Forgets the data key. Unlock again with the passcode to continue. */
  lock(): void {
    this.dataKey?.fill(0);
    this.dataKey = undefined;
  }

  /** Deletes everything this vault stored, then locks. */
  async wipe(): Promise<void> {
    for (const key of await this.deps.store.keys()) await this.deps.store.delete(key);
    this.lock();
  }
}

export async function createVault(deps: VaultDeps, passcode: string): Promise<Vault> {
  if ([...passcode].length < MIN_PASSCODE_LENGTH) throw new VaultError('passcode_too_short');
  if ((await deps.store.get(META_KEY)) !== undefined) throw new VaultError('exists');
  const kdf = deps.kdf ?? DEFAULT_KDF;
  const salt = deps.sodium.newSalt();
  const dataKey = deps.sodium.randomKey();
  const head = header(kdf, salt);
  const wrapped = deps.sodium.seal(deps.sodium.deriveKey(passcode, salt, kdf), dataKey, head);
  const meta = new Uint8Array(head.length + wrapped.length);
  meta.set(head);
  meta.set(wrapped, head.length);
  await deps.store.put(META_KEY, meta);
  return new Vault(deps, dataKey);
}

export async function unlockVault(deps: VaultDeps, passcode: string): Promise<Vault> {
  const meta = await deps.store.get(META_KEY);
  if (meta === undefined) throw new VaultError('no_vault');
  try {
    const { kdf, salt } = parseHeader(meta);
    const wrapKey = deps.sodium.deriveKey(passcode, salt, kdf);
    const dataKey = deps.sodium.open(
      wrapKey,
      meta.slice(HEADER_BYTES),
      meta.slice(0, HEADER_BYTES),
    );
    return new Vault(deps, dataKey);
  } catch (error) {
    // Only a failed decryption means a wrong passcode. A short or odd header, weak cost or bad
    // salt all mean the stored header is damaged.
    const wrong = (error as { code?: string }).code === 'decrypt_failed';
    throw new VaultError(wrong ? 'wrong_passcode' : 'corrupt');
  }
}
