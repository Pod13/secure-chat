import { beforeAll, describe, expect, test } from 'vitest';

import { createSodium, type Sodium } from '../src/crypto/sodium';
import { toBase64Url } from '../src/net/base64';
import { webRandom } from '../src/ports';
import { Guard, pathFor, type NetResponse } from '../src/sw/guard';
import {
  canonicalJson,
  encodeSigned,
  type Manifest,
  type ManifestCrypto,
} from '../src/sw/manifest';
import { MemoryStore } from './fakes';

let sodium: Sodium;
let crypto: ManifestCrypto;
let pair: { publicKey: Uint8Array; secretKey: Uint8Array };
beforeAll(async () => {
  sodium = await createSodium(webRandom);
  crypto = { sha256: sodium.sha256, verify: sodium.verifyDetached };
  pair = sodium.signingKeyPair(new Uint8Array(32).fill(3));
  V1 = release('1.0.0', { 'index.html': '<html>one', 'app.js': 'one()' });
});

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array): string => new TextDecoder().decode(data);

function release(
  version: string,
  files: Record<string, string>,
  secretKey = pair.secretKey,
  minClientVersion = '1.0.0',
  keys: { keyId?: string; trustedKeys?: Record<string, string>; revokedKeys?: string[] } = {},
) {
  const manifest: Manifest = {
    v: 1,
    version,
    minClientVersion,
    keyId: keys.keyId ?? 'release-1',
    trustedKeys: keys.trustedKeys ?? {},
    revokedKeys: keys.revokedKeys ?? [],
    files: Object.fromEntries(
      Object.entries(files).map(([path, body]) => [path, toBase64Url(sodium.sha256(bytes(body)))]),
    ),
  };
  const manifestText = canonicalJson(manifest);
  const signature = toBase64Url(sodium.signDetached(secretKey, bytes(manifestText)));
  return { files, signed: encodeSigned(manifestText, signature) };
}

/** A server whose contents the test can change; unknown paths are 404. */
class FakeServer {
  failing = false;
  constructor(public site: Record<string, string>) {}
  calls: string[] = [];
  fetch = (path: string): Promise<NetResponse> => {
    this.calls.push(path);
    if (this.failing) return Promise.reject(new Error('offline'));
    const body = this.site[path];
    return Promise.resolve(
      body === undefined
        ? { status: 404, body: new Uint8Array(), contentType: 'text/plain' }
        : {
            status: 200,
            body: bytes(body),
            contentType: path.endsWith('.js') ? 'text/javascript' : 'text/html',
          },
    );
  };
}

function setup(site: Record<string, string>, store = new MemoryStore(), clientVersion = '1.0.0') {
  const server = new FakeServer(site);
  const guard = new Guard({
    crypto,
    trustedKeys: { 'release-1': pair.publicKey },
    network: server.fetch,
    store,
    clientVersion,
  });
  return { server, guard, store };
}

let V1: ReturnType<typeof release>;
const siteFor = (r: ReturnType<typeof release>) => ({ ...r.files, 'manifest.json': r.signed });

describe('pathFor', () => {
  test('maps request paths to release paths and refuses odd ones', () => {
    expect(pathFor('/')).toBe('index.html');
    expect(pathFor('/index.html')).toBe('index.html');
    expect(pathFor('/assets/app.js')).toBe('assets/app.js');
    for (const bad of [
      '',
      'app.js',
      '//x',
      '/a//b',
      '/a/../b',
      '/..',
      '/a/.',
      '/a\\b',
      '/%2e%2e/x',
    ]) {
      expect(pathFor(bad), bad).toBeUndefined();
    }
  });
});

describe('serving', () => {
  test('serves a listed file whose bytes match, with its content type', async () => {
    const { guard } = setup(siteFor(V1));
    const result = await guard.serve('/app.js');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(text(result.body)).toBe('one()');
      expect(result.contentType).toBe('text/javascript');
    }
  });

  test('the first request fetches and checks the manifest, later ones reuse it', async () => {
    const { guard, server } = setup(siteFor(V1));
    await guard.serve('/');
    await guard.serve('/app.js');
    expect(server.calls.filter((c) => c === 'manifest.json').length).toBe(1);
    expect(guard.version).toBe('1.0.0');
  });

  test('refuses a file that was swapped on the server', async () => {
    const { guard, server } = setup(siteFor(V1));
    await guard.serve('/app.js');
    server.site['app.js'] = 'evil()';
    expect(await guard.serve('/app.js')).toEqual({ ok: false, reason: 'hash_mismatch' });
  });

  test('refuses a file that is not in the manifest, and bad paths', async () => {
    const { guard } = setup({ ...siteFor(V1), 'extra.js': 'x' });
    expect(await guard.serve('/extra.js')).toEqual({ ok: false, reason: 'not_listed' });
    expect(await guard.serve('/../x')).toEqual({ ok: false, reason: 'not_listed' });
    expect(await guard.serve('/manifest.json')).toEqual({ ok: false, reason: 'not_listed' });
  });

  test('reports network trouble and missing files as such', async () => {
    const { guard, server } = setup(siteFor(V1));
    await guard.serve('/');
    delete server.site['app.js'];
    expect(await guard.serve('/app.js')).toEqual({ ok: false, reason: 'network' });
    server.failing = true;
    expect(await guard.serve('/app.js')).toEqual({ ok: false, reason: 'network' });
  });

  test('without a verified manifest nothing is served', async () => {
    const forged = release(
      '1.0.0',
      { 'index.html': 'x' },
      sodium.signingKeyPair(new Uint8Array(32).fill(9)).secretKey,
    );
    const { guard } = setup({ ...forged.files, 'manifest.json': forged.signed });
    expect(await guard.serve('/')).toEqual({ ok: false, reason: 'no_manifest' });
    const offline = setup(siteFor(V1));
    offline.server.failing = true;
    expect(await offline.guard.serve('/')).toEqual({ ok: false, reason: 'no_manifest' });
  });
});

describe('updating', () => {
  test('accepts a newer signed release and serves its files', async () => {
    const { guard, server } = setup(siteFor(V1));
    await guard.serve('/');
    const v2 = release('1.1.0', { 'index.html': '<html>two', 'app.js': 'two()' });
    Object.assign(server.site, siteFor(v2));
    expect(await guard.refresh()).toEqual({ ok: true, version: '1.1.0' });
    expect(text(((await guard.serve('/app.js')) as { body: Uint8Array }).body)).toBe('two()');
  });

  test('refuses a downgrade, even if correctly signed', async () => {
    const { guard, server } = setup(siteFor(release('2.0.0', { 'index.html': 'new' })));
    await guard.serve('/');
    Object.assign(server.site, siteFor(V1));
    expect(await guard.refresh()).toEqual({ ok: false, reason: 'downgrade' });
    expect(guard.version).toBe('2.0.0');
  });

  test('the same version again is unchanged only if identical, otherwise refused', async () => {
    const { guard, server } = setup(siteFor(V1));
    await guard.serve('/');
    expect(await guard.refresh()).toEqual({ ok: true, version: '1.0.0' });
    const altered = release('1.0.0', { 'index.html': '<html>other' });
    Object.assign(server.site, siteFor(altered));
    expect(await guard.refresh()).toEqual({ ok: false, reason: 'conflict' });
    expect(guard.version).toBe('1.0.0');
  });

  test('a forged, untrusted or unreachable manifest changes nothing', async () => {
    const { guard, server } = setup(siteFor(V1));
    await guard.serve('/');
    const forged = release(
      '9.0.0',
      { 'index.html': 'x' },
      sodium.signingKeyPair(new Uint8Array(32).fill(9)).secretKey,
    );
    Object.assign(server.site, siteFor(forged));
    expect(await guard.refresh()).toEqual({ ok: false, reason: 'bad_signature' });
    server.site['manifest.json'] = 'garbage';
    expect(await guard.refresh()).toEqual({ ok: false, reason: 'malformed' });
    server.failing = true;
    expect(await guard.refresh()).toEqual({ ok: false, reason: 'network' });
    delete server.site['manifest.json'];
    server.failing = false;
    expect(await guard.refresh()).toEqual({ ok: false, reason: 'network' });
    expect(guard.version).toBe('1.0.0');
  });
});

describe('remembering a release', () => {
  test('a new guard loads the stored manifest and works offline', async () => {
    const first = setup(siteFor(V1));
    await first.guard.serve('/');
    const again = setup(siteFor(V1), first.store);
    again.server.failing = true;
    expect(await again.guard.load()).toBe(true);
    expect(again.guard.version).toBe('1.0.0');
    expect(await again.guard.load()).toBe(true);
  });

  test('stored manifests that were altered or never saved are not trusted', async () => {
    const empty = setup(siteFor(V1));
    expect(await empty.guard.load()).toBe(false);
    expect(empty.guard.version).toBeUndefined();
    const first = setup(siteFor(V1));
    await first.guard.serve('/');
    const stored = first.store.entries.get('sw:manifest') as Uint8Array;
    stored[10] = (stored[10] ?? 0) ^ 1;
    const again = setup(siteFor(V1), first.store);
    expect(await again.guard.load()).toBe(false);
    expect(again.guard.version).toBeUndefined();
  });
});

describe('forced update', () => {
  test('an old client is stopped once the manifest demands a newer one', async () => {
    const strict = release('2.0.0', { 'index.html': 'new' }, undefined, '1.5.0');
    const old = setup(siteFor(strict), new MemoryStore(), '1.0.0');
    expect(await old.guard.serve('/')).toEqual({ ok: false, reason: 'update_required' });
    expect(await old.guard.serve('/index.html')).toEqual({ ok: false, reason: 'update_required' });
    expect(old.guard.minimumVersion).toBe('1.5.0');
  });

  test('a client at the minimum, or newer, keeps running', async () => {
    const strict = release('2.0.0', { 'index.html': 'new' }, undefined, '1.5.0');
    for (const version of ['1.5.0', '1.6.0', '2.0.0']) {
      const current = setup(siteFor(strict), new MemoryStore(), version);
      expect((await current.guard.serve('/')).ok, version).toBe(true);
    }
  });

  test('a later manifest can raise the minimum above a running client', async () => {
    const { guard, server } = setup(siteFor(V1), new MemoryStore(), '1.0.0');
    expect((await guard.serve('/')).ok).toBe(true);
    Object.assign(
      server.site,
      siteFor(release('1.1.0', { 'index.html': 'x' }, undefined, '1.1.0')),
    );
    await guard.refresh();
    expect(await guard.serve('/')).toEqual({ ok: false, reason: 'update_required' });
  });

  test('without a manifest there is no minimum to report', () => {
    expect(setup({}).guard.minimumVersion).toBeUndefined();
  });
});

describe('key rotation and revocation', () => {
  const second = () => sodium.signingKeyPair(new Uint8Array(32).fill(8));

  test('a release signed by a newly introduced key is accepted, and the key survives a restart', async () => {
    const next = second();
    const { guard, server, store } = setup(siteFor(V1));
    await guard.serve('/');
    const introduces = release('1.1.0', { 'index.html': 'a' }, undefined, '1.0.0', {
      trustedKeys: { 'release-2': toBase64Url(next.publicKey) },
    });
    Object.assign(server.site, siteFor(introduces));
    expect(await guard.refresh()).toEqual({ ok: true, version: '1.1.0' });

    const signedByNew = release('1.2.0', { 'index.html': 'b' }, next.secretKey, '1.0.0', {
      keyId: 'release-2',
      trustedKeys: { 'release-2': toBase64Url(next.publicKey) },
    });
    Object.assign(server.site, siteFor(signedByNew));
    expect(await guard.refresh()).toEqual({ ok: true, version: '1.2.0' });

    expect(store.entries.has('sw:keys')).toBe(true);
    const restarted = setup(siteFor(signedByNew), store);
    expect(await restarted.guard.load()).toBe(true);
    expect(restarted.guard.version).toBe('1.2.0');
  });
});

describe('key rotation and revocation, refusals', () => {
  const second = () => sodium.signingKeyPair(new Uint8Array(32).fill(8));

  test('a key nobody introduced is refused', async () => {
    const stranger = second();
    const { guard, server } = setup(siteFor(V1));
    await guard.serve('/');
    const forged = release('1.5.0', { 'index.html': 'x' }, stranger.secretKey, '1.0.0', {
      keyId: 'release-2',
    });
    Object.assign(server.site, siteFor(forged));
    expect(await guard.refresh()).toEqual({ ok: false, reason: 'unknown_key' });
  });
});

describe('revocation', () => {
  const second = () => sodium.signingKeyPair(new Uint8Array(32).fill(8));

  test('after a key is revoked, even a correctly signed manifest from it is refused', async () => {
    const next = second();
    const { guard, server } = setup(siteFor(V1));
    await guard.serve('/');
    const revokes = release('1.1.0', { 'index.html': 'a' }, undefined, '1.0.0', {
      trustedKeys: { 'release-2': toBase64Url(next.publicKey) },
      revokedKeys: ['release-1'],
    });
    Object.assign(server.site, siteFor(revokes));
    // The revoking release is itself signed by the key it revokes; it is accepted once.
    expect(await guard.refresh()).toEqual({ ok: true, version: '1.1.0' });
    const replay = release('1.2.0', { 'index.html': 'b' }, undefined, '1.0.0', {
      revokedKeys: ['release-1'],
    });
    Object.assign(server.site, siteFor(replay));
    expect(await guard.refresh()).toEqual({ ok: false, reason: 'revoked_key' });
  });

  test('a release that drops an earlier revocation is refused', async () => {
    const next = second();
    const { guard, server } = setup(siteFor(V1));
    await guard.serve('/');
    const revokes = release('1.1.0', { 'index.html': 'a' }, undefined, '1.0.0', {
      trustedKeys: { 'release-2': toBase64Url(next.publicKey) },
      revokedKeys: ['release-9'],
    });
    Object.assign(server.site, siteFor(revokes));
    await guard.refresh();
    const forgets = release('1.2.0', { 'index.html': 'b' }, undefined, '1.0.0', {
      revokedKeys: [],
    });
    Object.assign(server.site, siteFor(forgets));
    expect(await guard.refresh()).toEqual({ ok: false, reason: 'revocation_removed' });
  });

  test('revocations pinned into the build apply from the first request', async () => {
    const server = new FakeServer(siteFor(V1));
    const guard = new Guard({
      crypto,
      trustedKeys: { 'release-1': pair.publicKey },
      pinnedRevoked: ['release-1'],
      network: server.fetch,
      store: new MemoryStore(),
      clientVersion: '1.0.0',
    });
    expect(await guard.serve('/')).toEqual({ ok: false, reason: 'no_manifest' });
    expect(await guard.refresh()).toEqual({ ok: false, reason: 'revoked_key' });
  });
});
