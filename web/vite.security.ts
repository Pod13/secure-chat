// Build-time page hardening (Constitution VII): a strict Content Security Policy, and a
// Subresource Integrity hash on every script and stylesheet. Applied only to production builds;
// the dev server needs inline code that this policy forbids.
//
// The same policy must also be sent as an HTTP header by whatever serves the files (a meta tag
// cannot carry `frame-ancestors`); see docs/operations.md.

import { createHash } from 'node:crypto';

import type { Plugin } from 'vite';

export const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ');

type BundleItem = { type: 'chunk'; code: string } | { type: 'asset'; source: string | Uint8Array };
type Bundle = Readonly<Record<string, BundleItem>>;

function contentOf(item: BundleItem): string | Uint8Array {
  return item.type === 'chunk' ? item.code : item.source;
}

function integrityFor(reference: string, bundle: Bundle): string {
  const item = bundle[reference.replace(/^\//, '')];
  if (item === undefined) throw new Error(`index.html refers to ${reference}, which was not built`);
  return `sha384-${createHash('sha384').update(contentOf(item)).digest('base64')}`;
}

/** Adds `integrity` and `crossorigin="anonymous"` to local scripts, stylesheets and preloads. */
export function addIntegrity(html: string, bundle: Bundle): string {
  if (
    /<script\b(?![^>]*\bsrc=)[^>]*>/i.test(html) ||
    /<style\b/i.test(html) ||
    /\sstyle=/i.test(html)
  ) {
    throw new Error('inline script or style found in index.html');
  }
  return html.replace(
    /<(script|link)\b([^>]*?)(\/?)>/gi,
    (tag, name: string, attrs: string, close: string) => {
      const reference = /\b(?:src|href)="([^"]+)"/.exec(attrs)?.[1];
      const isAsset =
        name.toLowerCase() === 'script' || /rel="(stylesheet|modulepreload)"/.test(attrs);
      if (reference === undefined || !isAsset) return tag;
      const bare = attrs.replace(/\s+crossorigin(="[^"]*")?/g, '');
      return `<${name}${bare} integrity="${integrityFor(reference, bundle)}" crossorigin="anonymous"${close}>`;
    },
  );
}

export function withSecurityTags(html: string): string {
  return html.replace(
    '<head>',
    `<head><meta http-equiv="Content-Security-Policy" content="${CSP}">`,
  );
}

export function securityPlugin(): Plugin {
  return {
    name: 'secure-chat-security',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html, context) =>
        withSecurityTags(addIntegrity(html, (context.bundle ?? {}) as Bundle)),
    },
  };
}
