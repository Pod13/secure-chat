// The rule the service worker enforces: serve only files that the signed manifest lists, with
// exactly the listed content. Everything else is refused, so a server (or a network attacker)
// that swaps a file cannot get it run. The worker's browser hooks are in `sw.ts`; the rules are
// here so they can be tested without a browser.

import type { KeyValueStore } from '../ports';
import { activeKeys, advance, decodeState, encodeState, initialState, type KeyState } from './keys';
import { needsUpdate } from './update';
import {
  fileMatches,
  verifyManifest,
  type Manifest,
  type ManifestCrypto,
  type VerifyFailure,
} from './manifest';
import { compareVersions } from './version';

const MANIFEST_PATH = 'manifest.json';
const STORE_KEY = 'sw:manifest';
const KEYS_KEY = 'sw:keys';

export interface NetResponse {
  status: number;
  body: Uint8Array;
  contentType: string;
}

export interface GuardDeps {
  crypto: ManifestCrypto;
  /** Public keys pinned into this build, by key id. */
  trustedKeys: Readonly<Record<string, Uint8Array>>;
  /** Key ids pinned as revoked in this build. */
  pinnedRevoked?: readonly string[];
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
      reason: VerifyFailure | 'network' | 'downgrade' | 'conflict' | 'revocation_removed';
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
  private keys: KeyState;

  constructor(private readonly deps: GuardDeps) {
    this.keys = initialState(deps.trustedKeys, deps.pinnedRevoked ?? []);
  }

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
    const saved = decodeState(await this.deps.store.get(KEYS_KEY), this.keys);
    const result = this.verify(text, saved);
    if (result.ok) {
      this.current = { manifest: result.manifest, text };
      this.keys = saved;
    }
    return result.ok;
  }

  /** Fetches the newest manifest and accepts it only if signed, trusted and not older. */
  async refresh(): Promise<RefreshResult> {
    const fetched = await this.tryFetch(MANIFEST_PATH);
    if (fetched === undefined) return { ok: false, reason: 'network' };
    const text = new TextDecoder().decode(fetched.body);
    const result = this.verify(text, this.keys);
    if (!result.ok) return result;
    const nextKeys = advance(this.keys, result.manifest);
    if (nextKeys === undefined) return { ok: false, reason: 'revocation_removed' };
    const previous = this.current;
    if (previous !== undefined) {
      const order = compareVersions(result.manifest.version, previous.manifest.version);
      if (order < 0) return { ok: false, reason: 'downgrade' };
      if (order === 0 && previous.text !== text) return { ok: false, reason: 'conflict' };
    }
    this.current = { manifest: result.manifest, text };
    this.keys = nextKeys;
    await this.deps.store.put(STORE_KEY, new TextEncoder().encode(text));
    await this.deps.store.put(KEYS_KEY, encodeState(nextKeys));
    return { ok: true, version: result.manifest.version };
  }

  private verify(text: string, keys: KeyState) {
    return verifyManifest(text, activeKeys(keys), this.deps.crypto, keys.revoked);
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
