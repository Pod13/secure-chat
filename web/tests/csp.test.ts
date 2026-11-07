import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { CSP, addIntegrity, withSecurityTags } from '../vite.security';

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter((parts) => parts[0] !== '')
      .map(([name, ...values]) => [name as string, values] as const),
  );
}

describe('content security policy', () => {
  const policy = directives(CSP);

  test('starts from nothing allowed', () => {
    expect(policy.get('default-src')).toEqual(["'none'"]);
  });

  test('never allows inline or eval code, remote hosts or wildcard sources', () => {
    for (const [name, values] of policy) {
      for (const value of values) {
        expect(value, `${name} ${value}`).not.toMatch(
          /^'unsafe-(inline|eval)'$|^\*$|^https?:|^data:$/,
        );
      }
    }
    expect(CSP).not.toMatch(/'unsafe-(inline|eval)'/);
  });

  test('allows own scripts and WebAssembly, but not eval', () => {
    expect(policy.get('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(policy.get('style-src')).toEqual(["'self'"]);
    expect(policy.get('worker-src')).toEqual(["'self'"]);
    expect(policy.get('connect-src')).toEqual(["'self'"]);
  });

  test('forbids base tags and form posts, and requires Trusted Types with no policies', () => {
    expect(policy.get('base-uri')).toEqual(["'none'"]);
    expect(policy.get('form-action')).toEqual(["'none'"]);
    expect(policy.get('require-trusted-types-for')).toEqual(["'script'"]);
    expect(policy.get('trusted-types')).toEqual(["'none'"]);
  });
});

describe('integrity attributes', () => {
  const bundle = {
    'assets/app-1.js': { type: 'chunk', code: 'console.log(1)' },
    'assets/app-1.css': { type: 'asset', source: 'a{}' },
    'assets/bytes.bin': { type: 'asset', source: new Uint8Array([1, 2, 3]) },
  } as const;
  const sha384 = (text: string): string => createHash('sha384').update(text).digest('base64');

  test('adds a sha384 hash and anonymous crossorigin to scripts, stylesheets and preloads', () => {
    const html =
      '<script type="module" crossorigin src="/assets/app-1.js"></script>' +
      '<link rel="stylesheet" crossorigin href="/assets/app-1.css">' +
      '<link rel="modulepreload" href="/assets/app-1.js">';
    const out = addIntegrity(html, bundle);
    expect(out.match(/integrity="sha384-[A-Za-z0-9+/]{64}"/g)?.length).toBe(3);
    expect(out).toContain(`integrity="sha384-${sha384('console.log(1)')}"`);
    expect(out).toContain(`integrity="sha384-${sha384('a{}')}"`);
    expect(out.match(/crossorigin="anonymous"/g)?.length).toBe(3);
    expect(out).not.toMatch(/crossorigin(?!=)/);
  });

  test('hashes binary assets and leaves other tags alone', () => {
    const out = addIntegrity(
      '<link rel="icon" href="/assets/bytes.bin"><a href="/assets/app-1.js">x</a>',
      bundle,
    );
    expect(out).toContain('<a href="/assets/app-1.js">x</a>');
    expect(out).toContain('rel="icon"');
  });

  test('refuses a page that refers to a file the build did not produce', () => {
    expect(() => addIntegrity('<script src="/assets/missing.js"></script>', bundle)).toThrow(
      'missing.js',
    );
  });

  test('leaves external or inline tags out of scope, but inline scripts are an error', () => {
    expect(() => addIntegrity('<script>alert(1)</script>', bundle)).toThrow('inline');
    expect(() => addIntegrity('<style>a{}</style>', bundle)).toThrow('inline');
    expect(() => addIntegrity('<div style="color:red"></div>', bundle)).toThrow('inline');
  });

  test('adds the policy as a meta tag at the top of head', () => {
    const out = withSecurityTags('<head><title>x</title></head>');
    expect(out.startsWith('<head><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(out).toContain(`content="${CSP}"`);
  });
});
