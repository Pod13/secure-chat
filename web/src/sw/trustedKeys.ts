// The manifest-signing public keys this build trusts, pinned at build time from the
// RELEASE_PUBLIC_KEYS environment variable (see `sw.ts`): "id:base64url-key,id2:base64url-key". Public keys are
// not secret. Rotation and revocation are handled in T043. With no keys set, nothing verifies, so
// a production build without keys refuses to start (fails closed).

import { fromBase64Url } from '../net/base64';

/** Parses "id:key,id2:key2". Entries that are not a well-formed 32-byte key are dropped. */
export function parseKeys(spec: string): Record<string, Uint8Array> {
  const keys: Record<string, Uint8Array> = {};
  for (const entry of spec.split(',')) {
    const parts = entry.split(':');
    const id = parts[0] as string;
    const key = parts.length === 2 ? fromBase64Url(parts[1] as string) : undefined;
    if (/^[a-z0-9-]{1,32}$/.test(id) && key?.length === 32) keys[id] = key;
  }
  return keys;
}
