import { beforeAll, describe, expect, test } from 'vitest';

import { createSodium, type Sodium } from '../src/crypto/sodium';
import { toBase64Url } from '../src/net/base64';
import { webRandom } from '../src/ports';
import {
  canonicalJson,
  encodeSigned,
  fileMatches,
  verifyManifest,
  type Manifest,
  type ManifestCrypto,
} from '../src/sw/manifest';

let sodium: Sodium;
let crypto: ManifestCrypto;
let pair: { publicKey: Uint8Array; secretKey: Uint8Array };
beforeAll(async () => {
  sodium = await createSodium(webRandom);
  crypto = { sha256: sodium.sha256, verify: sodium.verifyDetached };
  pair = sodium.signingKeyPair(new Uint8Array(32).fill(3));
});

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    v: 1,
    version: '1.2.3',
    minClientVersion: '1.0.0',
    keyId: 'release-1',
    files: { 'index.html': toBase64Url(sodium.sha256(bytes('<html>'))) },
    ...overrides,
  };
}

function sign(m: Manifest, key = pair.secretKey): string {
  const text = canonicalJson(m);
  return encodeSigned(text, toBase64Url(sodium.signDetached(key, bytes(text))));
}

const trusted = () => ({ 'release-1': pair.publicKey });

describe('canonicalJson', () => {
  test('sorts keys at every level and leaves no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: 'é' } })).toBe(
      '{"a":{"c":"é","d":[3,{"x":2,"y":1}]},"b":1}',
    );
  });

  test('writes scalars and null as JSON', () => {
    expect(canonicalJson([null, true, 'a', 1.5])).toBe('[null,true,"a",1.5]');
    expect(canonicalJson(null)).toBe('null');
  });

  test('the same data always gives the same text', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });
});

describe('verifyManifest', () => {
  test('accepts a manifest signed by a trusted key', () => {
    const result = verifyManifest(sign(manifest()), trusted(), crypto);
    expect(result).toEqual({ ok: true, manifest: manifest() });
  });

  test('rejects a signature made by another key', () => {
    const other = sodium.signingKeyPair(new Uint8Array(32).fill(4));
    expect(verifyManifest(sign(manifest(), other.secretKey), trusted(), crypto)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  test('rejects a key id that is not trusted', () => {
    expect(verifyManifest(sign(manifest({ keyId: 'unknown' })), trusted(), crypto)).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
    expect(
      verifyManifest(sign(manifest({ keyId: ['release-1'] as never })), trusted(), crypto),
    ).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
    expect(verifyManifest(sign(manifest({ keyId: 'constructor' })), trusted(), crypto)).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
  });

  test('rejects any change to the signed text', () => {
    const signed = JSON.parse(sign(manifest())) as { manifest: string; signature: string };
    const changed = { ...signed, manifest: signed.manifest.replace('1.2.3', '9.9.9') };
    expect(verifyManifest(JSON.stringify(changed), trusted(), crypto)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });
});

describe('verifyManifest, bad input', () => {
  test('rejects text that is not a signed manifest', () => {
    const good = JSON.parse(sign(manifest())) as Record<string, string>;
    const bad = [
      '',
      'not json',
      '[]',
      'null',
      '{}',
      JSON.stringify({ ...good, extra: 1 }),
      JSON.stringify({ manifest: good.manifest }),
      JSON.stringify({ ...good, signature: 5 }),
      JSON.stringify({ ...good, signature: 'x' }),
      JSON.stringify({ ...good, manifest: 5 }),
    ];
    for (const text of bad) {
      expect(verifyManifest(text, trusted(), crypto), text).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });
});

const invalidManifests = (): unknown[] => [
  manifest({ v: 2 as 1 }),
  manifest({ version: '1.2' }),
  manifest({ version: '01.2.3' }),
  manifest({ minClientVersion: 'x' }),
  manifest({ version: 5 as never }),
  manifest({ minClientVersion: 5 as never }),
  manifest({ files: { 'a/./b': 'A'.repeat(43) } }),
  manifest({ files: { 'a//b': 'A'.repeat(43) } }),
  manifest({ files: { 'a/..': 'A'.repeat(43) } }),
  manifest({ files: { 'a/': 'A'.repeat(43) } }),
  manifest({ files: { '.': 'A'.repeat(43) } }),
  manifest({ files: { 'a.js': 5 as never } }),
  manifest({ files: { 'a.js': 'A'.repeat(44) } }),
  manifest({ files: { 'a.js': 'A'.repeat(42) } }),
  manifest({ files: { 'good.js': 'A'.repeat(43), 'bad.js': 'short' } }),
  manifest({ version: ['1.2.3'] as never }),
  manifest({ minClientVersion: ['1.0.0'] as never }),
  manifest({ files: { 'a.js': Array(43).fill('A') as never } }),
  ...['v1.2.3', '1.2.3.4', '1.2.3 ', ' 1.2.3', '1.2.x', '1..2', '1.2.-3', 'a1.2.3', '1.2.3a'].map(
    (version) => manifest({ version }),
  ),
  manifest({ minClientVersion: '1.2.3 ' }),
  manifest({ files: {} }),
  manifest({ files: 5 as never }),
  manifest({ files: null as never }),
  manifest({ files: { '../x': 'A'.repeat(43) } }),
  manifest({ files: { '/abs': 'A'.repeat(43) } }),
  manifest({ files: { '': 'A'.repeat(43) } }),
  manifest({ files: { 'a.js': 'short' } }),
  { ...manifest(), extra: true },
];

describe('verifyManifest, bad content', () => {
  test('rejects a correctly signed manifest whose content is not valid', () => {
    for (const m of invalidManifests()) {
      const text = canonicalJson(m);
      const signed = encodeSigned(
        text,
        toBase64Url(sodium.signDetached(pair.secretKey, bytes(text))),
      );
      expect(verifyManifest(signed, trusted(), crypto), text).toEqual({
        ok: false,
        reason: 'bad_manifest',
      });
    }
  });

  test('a manifest whose key id is not even well formed, or not JSON, has no key to check', () => {
    const odd = encodeSigned(canonicalJson(manifest({ keyId: 'Bad Key' })), 'A'.repeat(86));
    expect(verifyManifest(odd, trusted(), crypto)).toEqual({ ok: false, reason: 'unknown_key' });
    const text = 'not json {';
    const signed = encodeSigned(
      text,
      toBase64Url(sodium.signDetached(pair.secretKey, bytes(text))),
    );
    expect(verifyManifest(signed, trusted(), crypto)).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
  });
});

describe('versions', () => {
  test('multi-digit and zero parts are valid', () => {
    for (const version of ['10.20.30', '0.0.0', '1.0.100', '100.0.0']) {
      expect(verifyManifest(sign(manifest({ version })), trusted(), crypto).ok, version).toBe(true);
    }
  });
});

describe('fileMatches', () => {
  test('is true only for the listed path with the listed content', () => {
    const m = manifest();
    expect(fileMatches(m, 'index.html', bytes('<html>'), crypto)).toBe(true);
    expect(fileMatches(m, 'index.html', bytes('<html>!'), crypto)).toBe(false);
    expect(fileMatches(m, 'other.js', bytes('<html>'), crypto)).toBe(false);
    expect(fileMatches(m, 'constructor', bytes('<html>'), crypto)).toBe(false);
  });
});
