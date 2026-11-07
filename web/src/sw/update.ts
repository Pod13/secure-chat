// Forced update (research R-update): the signed manifest names the oldest client allowed to run.
// A client older than that is stopped by the service worker, so a known-broken or insecure
// version cannot keep handling messages.

import type { Manifest } from './manifest';
import { compareVersions } from './version';

export function needsUpdate(clientVersion: string, manifest: Manifest): boolean {
  return compareVersions(clientVersion, manifest.minClientVersion) < 0;
}

/** Plain page shown instead of the app. No scripts or styles, so it works under the strict CSP. */
export function updateRequiredPage(minimum: string, installed: string): string {
  return (
    '<!doctype html><meta charset="utf-8"><title>Update required</title>' +
    '<h1>An update is required</h1>' +
    `<p>This version (${installed}) is no longer allowed. Version ${minimum} or newer is needed ` +
    'to keep your messages safe. Close the app completely and open it again to update.</p>'
  );
}
