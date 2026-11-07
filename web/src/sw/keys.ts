// Signing-key rotation and revocation (research R-keys). The app starts with the keys pinned at
// build time. Each signed release may add keys (rotation) and revoke keys (a lost or leaked key).
// A revoked key is never trusted again, and a release may not forget an earlier revocation, so an
// old release signed by a revoked key cannot be replayed.

import { fromBase64Url, toBase64Url } from '../net/base64';
import type { Manifest } from './manifest';

export interface KeyState {
  trusted: Record<string, Uint8Array>;
  revoked: string[];
}

const KEY_ID = /^[a-z0-9-]{1,32}$/;

export function initialState(
  pinned: Readonly<Record<string, Uint8Array>>,
  pinnedRevoked: readonly string[],
): KeyState {
  return { trusted: { ...pinned }, revoked: [...pinnedRevoked] };
}

/** Keys that may sign a release: trusted and not revoked. */
export function activeKeys(state: KeyState): Record<string, Uint8Array> {
  return Object.fromEntries(
    Object.entries(state.trusted).filter(([id]) => !state.revoked.includes(id)),
  );
}

function decodeKeys(keys: Readonly<Record<string, string>>): Record<string, Uint8Array> {
  const decoded: Record<string, Uint8Array> = {};
  for (const [id, text] of Object.entries(keys)) decoded[id] = fromBase64Url(text) as Uint8Array;
  return decoded;
}

/** The state after accepting `manifest`, or `undefined` if it drops an earlier revocation. */
export function advance(state: KeyState, manifest: Manifest): KeyState | undefined {
  if (!state.revoked.every((id) => manifest.revokedKeys.includes(id))) return undefined;
  return {
    trusted: { ...state.trusted, ...decodeKeys(manifest.trustedKeys) },
    revoked: [...manifest.revokedKeys],
  };
}

export function encodeState(state: KeyState): Uint8Array {
  const trusted = Object.fromEntries(
    Object.entries(state.trusted).map(([id, key]) => [id, toBase64Url(key)]),
  );
  return new TextEncoder().encode(JSON.stringify({ trusted, revoked: state.revoked }));
}

function savedFields(saved: Uint8Array | undefined): {
  trusted: Record<string, Uint8Array>;
  revoked: string[];
} {
  const empty = { trusted: {}, revoked: [] };
  if (saved === undefined) return empty;
  try {
    const value = JSON.parse(new TextDecoder().decode(saved)) as {
      trusted?: Record<string, unknown>;
      revoked?: unknown[];
    };
    const trusted: Record<string, Uint8Array> = {};
    for (const [id, text] of Object.entries(value.trusted ?? {})) {
      const key = typeof text === 'string' ? fromBase64Url(text) : undefined;
      if (KEY_ID.test(id) && key?.length === 32) trusted[id] = key;
    }
    const revoked = (value.revoked ?? []).filter(
      (id): id is string => typeof id === 'string' && KEY_ID.test(id),
    );
    return { trusted, revoked };
  } catch {
    return empty;
  }
}

/** Saved state added to the pinned state: pinned keys stay, and pinned revocations always apply. */
export function decodeState(saved: Uint8Array | undefined, pinned: KeyState): KeyState {
  const fields = savedFields(saved);
  return {
    trusted: { ...fields.trusted, ...pinned.trusted },
    revoked: [...new Set([...fields.revoked, ...pinned.revoked])],
  };
}
