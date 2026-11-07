// The signed release manifest: which files make up a release, and who vouches for them. The
// service worker checks every file it serves against this list (T039). Signing happens outside
// the repository with keys held in an HSM; only public keys and verification live here.
//
// A signed manifest is `{"manifest": "<canonical JSON text>", "signature": "<base64url>"}`. The
// signature covers the exact bytes of the text, so there is no re-serialising before checking.

import { fromBase64Url, toBase64Url } from '../net/base64';

export interface Manifest {
  v: 1;
  version: string;
  /** The oldest client version still allowed to run (forced update, T042). */
  minClientVersion: string;
  keyId: string;
  /** Path (relative to the site root) to the SHA-256 of the file, base64url. */
  files: Record<string, string>;
}

export interface ManifestCrypto {
  sha256(data: Uint8Array): Uint8Array;
  verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean;
}

export type VerifyFailure = 'malformed' | 'unknown_key' | 'bad_signature' | 'bad_manifest';
export type VerifyResult = { ok: true; manifest: Manifest } | { ok: false; reason: VerifyFailure };

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HASH_CHARS = 43;
const SIGNATURE_BYTES = 64;

/** JSON with sorted keys and no whitespace: the same data always gives the same text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record).sort();
    return `{${fields.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function encodeSigned(manifestText: string, signature: string): string {
  return JSON.stringify({ manifest: manifestText, signature });
}

function isPath(path: string): boolean {
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function isVersion(value: unknown): boolean {
  return typeof value === 'string' && VERSION.test(value);
}

function isFileList(files: unknown): boolean {
  const entries = Object.entries((files ?? {}) as object);
  const valid = ([path, hash]: [string, unknown]) =>
    isPath(path) && typeof hash === 'string' && hash.length === HASH_CHARS;
  return entries.length > 0 && entries.every(valid);
}

/** `m` is an object whose key id is already trusted, so only the other fields are checked. */
function isManifest(m: Record<string, unknown>): m is Record<string, unknown> & Manifest {
  return (
    Object.keys(m).length === 5 &&
    m.v === 1 &&
    isVersion(m.version) &&
    isVersion(m.minClientVersion) &&
    isFileList(m.files)
  );
}

function parseSigned(text: string): { manifest: string; signature: Uint8Array } | undefined {
  let value: unknown = null;
  try {
    value = JSON.parse(text);
  } catch {
    // Not JSON: refused below.
  }
  const fields = value as Record<string, unknown> | null;
  if (fields === null || Object.keys(fields).length !== 2) return undefined;
  if (typeof fields.manifest !== 'string' || typeof fields.signature !== 'string') return undefined;
  const signature = fromBase64Url(fields.signature);
  return signature?.length === SIGNATURE_BYTES
    ? { manifest: fields.manifest, signature }
    : undefined;
}

function contentOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Checks the signature against the trusted public keys (by key id), then the content. The key
 * id is read only after parsing the content, but nothing is believed until the signature holds.
 */
export function verifyManifest(
  text: string,
  trustedKeys: Readonly<Record<string, Uint8Array>>,
  crypto: ManifestCrypto,
): VerifyResult {
  const signed = parseSigned(text);
  if (signed === undefined) return { ok: false, reason: 'malformed' };
  const content = contentOf(signed.manifest);
  const keyId = (content as { keyId?: unknown } | undefined)?.keyId;
  const key =
    typeof keyId === 'string' && Object.hasOwn(trustedKeys, keyId) ? trustedKeys[keyId] : undefined;
  if (key === undefined) return { ok: false, reason: 'unknown_key' };
  if (!crypto.verify(signed.signature, new TextEncoder().encode(signed.manifest), key)) {
    return { ok: false, reason: 'bad_signature' };
  }
  const fields = content as Record<string, unknown>;
  return isManifest(fields)
    ? { ok: true, manifest: fields }
    : { ok: false, reason: 'bad_manifest' };
}

/** True when `path` is listed and `bytes` hash to the listed value. Parsed JSON has no inherited names that could match a hash. */
export function fileMatches(
  manifest: Manifest,
  path: string,
  bytes: Uint8Array,
  crypto: ManifestCrypto,
): boolean {
  return toBase64Url(crypto.sha256(bytes)) === manifest.files[path];
}
