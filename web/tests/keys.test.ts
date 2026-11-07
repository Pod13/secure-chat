import { describe, expect, test } from 'vitest';

import { toBase64Url } from '../src/net/base64';
import type { Manifest } from '../src/sw/manifest';
import {
  activeKeys,
  advance,
  decodeState,
  encodeState,
  initialState,
  type KeyState,
} from '../src/sw/keys';

const raw = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const b64 = (fill: number): string => toBase64Url(raw(fill));

function manifest(trustedKeys: Record<string, string>, revokedKeys: string[]): Manifest {
  return {
    v: 1,
    version: '1.0.0',
    minClientVersion: '1.0.0',
    keyId: 'a',
    trustedKeys,
    revokedKeys,
    files: {},
  };
}

const start = (): KeyState => initialState({ a: raw(1), b: raw(2) }, []);

describe('initialState and activeKeys', () => {
  test('pinned keys are trusted unless pinned as revoked', () => {
    expect(Object.keys(activeKeys(start()))).toEqual(['a', 'b']);
    const withRevoked = initialState({ a: raw(1), b: raw(2) }, ['b', 'zzz']);
    expect(Object.keys(activeKeys(withRevoked))).toEqual(['a']);
    expect(withRevoked.revoked).toEqual(['b', 'zzz']);
  });
});

describe('advance', () => {
  test('a release can introduce a new key', () => {
    const next = advance(start(), manifest({ c: b64(3) }, [])) as KeyState;
    expect(Object.keys(activeKeys(next)).sort()).toEqual(['a', 'b', 'c']);
    expect(activeKeys(next).c).toEqual(raw(3));
  });

  test('a release can revoke a key, and the key stops being active for good', () => {
    const next = advance(start(), manifest({}, ['b'])) as KeyState;
    expect(Object.keys(activeKeys(next))).toEqual(['a']);
    const later = advance(next, manifest({ b: b64(2) }, ['b'])) as KeyState;
    expect(Object.keys(activeKeys(later))).toEqual(['a']);
  });

  test('a release that lists a key as both new and revoked leaves it revoked', () => {
    const next = advance(start(), manifest({ c: b64(3) }, ['c'])) as KeyState;
    expect(Object.keys(activeKeys(next)).sort()).toEqual(['a', 'b']);
  });

  test('a release that forgets an earlier revocation is refused', () => {
    const revoked = advance(start(), manifest({}, ['b'])) as KeyState;
    expect(advance(revoked, manifest({}, []))).toBeUndefined();
    expect(advance(revoked, manifest({}, ['x']))).toBeUndefined();
    expect(advance(revoked, manifest({}, ['b', 'x']))).toBeDefined();
  });

  test('does not change the state it was given', () => {
    const before = start();
    advance(before, manifest({ c: b64(3) }, ['a']));
    expect(Object.keys(before.trusted)).toEqual(['a', 'b']);
    expect(before.revoked).toEqual([]);
  });
});

describe('saved key ids', () => {
  const saved = (trusted: Record<string, string>, revoked: string[]) =>
    new TextEncoder().encode(JSON.stringify({ trusted, revoked }));

  test('only well-formed ids are kept', () => {
    const long = 'a'.repeat(32);
    const state = decodeState(
      saved({ [long]: b64(3), ['a'.repeat(33)]: b64(4), UPPER: b64(5), 'with space': b64(6) }, [
        long,
        'a'.repeat(33),
        'UPPER',
        '',
      ]),
      initialState({}, []),
    );
    expect(Object.keys(state.trusted)).toEqual([long]);
    expect(state.revoked).toEqual([long]);
  });
});

describe('saving state', () => {
  test('round-trips keys and revocations', () => {
    const state = advance(start(), manifest({ c: b64(3) }, ['b'])) as KeyState;
    const back = decodeState(encodeState(state), start());
    expect(Object.keys(activeKeys(back)).sort()).toEqual(['a', 'c']);
    expect(back.revoked).toEqual(['b']);
  });

  test('saved state never removes pinned keys, but pinned revocations always win', () => {
    const saved = encodeState(advance(start(), manifest({}, ['a'])) as KeyState);
    const pinnedMore = initialState({ a: raw(1), b: raw(2), d: raw(4) }, ['d']);
    const merged = decodeState(saved, pinnedMore);
    expect(Object.keys(activeKeys(merged))).toEqual(['b']);
    expect([...merged.revoked].sort()).toEqual(['a', 'd']);
  });

  test('missing or damaged saved state falls back to the pinned keys', () => {
    for (const bad of [
      undefined,
      new Uint8Array(),
      new TextEncoder().encode('nope'),
      new TextEncoder().encode('[]'),
    ]) {
      expect(Object.keys(activeKeys(decodeState(bad, start())))).toEqual(['a', 'b']);
    }
    const junk = new TextEncoder().encode(
      JSON.stringify({ trusted: { c: 'short', Bad: b64(3), d: 5 }, revoked: [5, 'ok'] }),
    );
    const state = decodeState(junk, start());
    expect(Object.keys(activeKeys(state))).toEqual(['a', 'b']);
    expect(state.revoked).toEqual(['ok']);
  });
});
