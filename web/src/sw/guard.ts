// The rule the service worker enforces: serve only files that the signed manifest lists, with
// exactly the listed content. Everything else is refused, so a server (or a network attacker)
// that swaps a file cannot get it run. The worker's browser hooks are in `sw.ts`; the rules are
// here so they can be tested without a browser.

import type { KeyValueStore } from '../ports';
import { needsUpdate } from './update';
import { fileMatches, verifyManifest, type Manifest, type ManifestCrypto } from './manifest';
import { compareVersions } from './version';

const MANIFEST_PATH = 'manifest.json';
const STORE_KEY = 'sw:manifest';

export interface NetResponse {
  status: number;
  body: Uint8Array;
  contentType: string;
}

export interface GuardDeps {
  crypto: ManifestCrypto;
  /** Public keys the app trusts, by key id. */
  trustedKeys: Readonly<Record<string, Uint8Array>>;
  /** Fetches a release path from the site's own origin. */
  network(path: string): Promise<NetResponse>;
  store: KeyValueStore;
  /** The version of this client build; compared with the manifest's minimum. */
  clientVersion: string;
}

export type ServeResult =
  | { ok: true; body: Uint8Array; contentType: string }
  | {
      ok: false;
      reason: 'no_manifest' | 'update_required' | 'not_listed' | 'hash_mismatch' | 'network';
    };

export type RefreshResult =
  | { ok: true; version: string }
  | {
      ok: false;
      reason:
        | 'network'
        | 'malformed'
        | 'unknown_key'
        | 'bad_signature'
        | 'bad_manifest'
        | 'downgrade'
        | 'conflict';
    };

/** Turns a request path into a release path, or `undefined` if it could point outside. */
export function pathFor(requestPath: string): string | undefined {
  if (requestPath === '/') return 'index.html';
  if (!requestPath.startsWith('/') || requestPath.includes('\\') || requestPath.includes('%')) {
    return undefined;
  }
  const parts = requestPath.slice(1).split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..')
    ? parts.join('/')
    : undefined;
}

export class Guard {
  private current: { manifest: Manifest; text: string } | undefined;

  constructor(private readonly deps: GuardDeps) {}

  get version(): string | undefined {
    return this.current?.manifest.version;
  }

  /** The oldest client version the current manifest allows. */
  get minimumVersion(): string | undefined {
    return this.current?.manifest.minClientVersion;
  }

  /** Restores the last accepted manifest from storage, checking it again. */
  async load(): Promise<boolean> {
    // A missing record decodes to "", which fails verification like any other bad manifest.
    const text = new TextDecoder().decode(await this.deps.store.get(STORE_KEY));
    const result = verifyManifest(text, this.deps.trustedKeys, this.deps.crypto);
    if (result.ok) this.current = { manifest: result.manifest, text };
    return result.ok;
  }

  /** Fetches the newest manifest and accepts it only if signed, trusted and not older. */
  async refresh(): Promise<RefreshResult> {
    const fetched = await this.tryFetch(MANIFEST_PATH);
    if (fetched === undefined) return { ok: false, reason: 'network' };
    const text = new TextDecoder().decode(fetched.body);
    const result = verifyManifest(text, this.deps.trustedKeys, this.deps.crypto);
    if (!result.ok) return result;
    const previous = this.current;
    if (previous !== undefined) {
      const order = compareVersions(result.manifest.version, previous.manifest.version);
      if (order < 0) return { ok: false, reason: 'downgrade' };
      if (order === 0 && previous.text !== text) return { ok: false, reason: 'conflict' };
    }
    this.current = { manifest: result.manifest, text };
    await this.deps.store.put(STORE_KEY, new TextEncoder().encode(text));
    return { ok: true, version: result.manifest.version };
  }

  async serve(requestPath: string): Promise<ServeResult> {
    if (this.current === undefined) await this.refresh();
    const manifest = this.current?.manifest;
    if (manifest === undefined) return { ok: false, reason: 'no_manifest' };
    if (needsUpdate(this.deps.clientVersion, manifest))
      return { ok: false, reason: 'update_required' };
    const path = pathFor(requestPath);
    if (path === undefined || !Object.hasOwn(manifest.files, path)) {
      return { ok: false, reason: 'not_listed' };
    }
    const response = await this.tryFetch(path);
    if (response === undefined) return { ok: false, reason: 'network' };
    if (!fileMatches(manifest, path, response.body, this.deps.crypto)) {
      return { ok: false, reason: 'hash_mismatch' };
    }
    return { ok: true, body: response.body, contentType: response.contentType };
  }

  private async tryFetch(path: string): Promise<NetResponse | undefined> {
    try {
      const response = await this.deps.network(path);
      return response.status === 200 ? response : undefined;
    } catch {
      return undefined;
    }
  }
}
