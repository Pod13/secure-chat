import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, test } from 'vitest';

import { createSodium, type Sodium } from '../src/crypto/sodium';
import { webRandom } from '../src/ports';
import { fileMatches, verifyManifest } from '../src/sw/manifest';
import {
  SIGNED,
  UNSIGNED,
  attachSignature,
  canonicalJson,
  listFiles,
  manifestText,
  writeUnsigned,
} from '../../build/sign-manifest';

let sodium: Sodium;
beforeAll(async () => {
  sodium = await createSodium(webRandom);
});

const scratch = (): string => mkdtempSync(join(tmpdir(), 'release-'));

function fixture(): string {
  const dir = scratch();
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<html>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  return dir;
}

const META = { version: '1.2.3', minClientVersion: '1.0.0', keyId: 'release-1' };

describe('manifest text', () => {
  test('lists every file with its hash, sorted, in canonical form', () => {
    const dir = fixture();
    expect(listFiles(dir)).toEqual(['assets/app.js', 'index.html']);
    const text = manifestText(dir, META);
    expect(text).toBe(canonicalJson(JSON.parse(text)));
    const parsed = JSON.parse(text) as { files: Record<string, string>; v: number };
    expect(parsed.v).toBe(1);
    expect(parsed.files['index.html']).toBe(
      createHash('sha256').update('<html>').digest('base64url'),
    );
  });

  test('does not list its own files', () => {
    const dir = fixture();
    writeUnsigned(dir, META);
    writeFileSync(join(dir, SIGNED), '{}');
    expect(listFiles(dir)).toEqual(['assets/app.js', 'index.html']);
  });

  test('canonical JSON handles scalars, arrays and nesting', () => {
    expect(canonicalJson({ b: [1, null, 'x'], a: { d: true, c: 2 } })).toBe(
      '{"a":{"c":2,"d":true},"b":[1,null,"x"]}',
    );
  });
});

describe('signing flow', () => {
  function signed(): { dir: string; publicKey: Uint8Array } {
    const dir = fixture();
    writeUnsigned(dir, META);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const signature = sign(null, readFileSync(join(dir, UNSIGNED)), privateKey);
    attachSignature(dir, signature, raw);
    return { dir, publicKey: raw };
  }

  test('the signed manifest passes the app-side verifier, and its files match', () => {
    const { dir, publicKey } = signed();
    const crypto = { sha256: sodium.sha256, verify: sodium.verifyDetached };
    const result = verifyManifest(
      readFileSync(join(dir, SIGNED), 'utf8'),
      { 'release-1': publicKey },
      crypto,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.version).toBe('1.2.3');
    const html = new Uint8Array(readFileSync(join(dir, 'index.html')));
    expect(fileMatches(result.manifest, 'index.html', html, crypto)).toBe(true);
    expect(fileMatches(result.manifest, 'index.html', new Uint8Array(1), crypto)).toBe(false);
  });
});

describe('signing flow, bad signatures', () => {
  test('a signature that does not match is never written', () => {
    const dir = fixture();
    writeUnsigned(dir, META);
    const mine = generateKeyPairSync('ed25519');
    const other = generateKeyPairSync('ed25519');
    const raw = other.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const signature = sign(null, readFileSync(join(dir, UNSIGNED)), mine.privateKey);
    expect(() => attachSignature(dir, signature, raw)).toThrow('signature does not match');
    expect(readdirSync(dir)).not.toContain(SIGNED);
  });

  test('wrong-sized signatures and keys are refused', () => {
    const dir = fixture();
    writeUnsigned(dir, META);
    expect(() => attachSignature(dir, new Uint8Array(63), new Uint8Array(32))).toThrow();
    expect(() => attachSignature(dir, new Uint8Array(64), new Uint8Array(31))).toThrow();
  });

  test('a signature over an older manifest is refused after the files change', () => {
    const dir = fixture();
    const text = writeUnsigned(dir, META);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const signature = sign(null, Buffer.from(text), privateKey);
    writeFileSync(join(dir, 'index.html'), '<html>tampered');
    writeUnsigned(dir, META);
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    expect(() => attachSignature(dir, signature, raw)).toThrow();
  });
});

describe('reproducible build', () => {
  test('two builds of the same source are byte-identical', () => {
    const build = (): string => {
      const out = join(scratch(), 'web');
      execFileSync(
        'bash',
        [join(__dirname, '..', '..', 'build', 'build.sh'), '0.0.0', '0.0.0', 'release-1', out],
        {
          stdio: 'pipe',
        },
      );
      return out;
    };
    const [a, b] = [build(), build()] as [string, string];
    const filesA = listFiles(a);
    expect(filesA).toEqual(listFiles(b));
    expect(filesA.length).toBeGreaterThan(1);
    for (const path of [...filesA, UNSIGNED]) {
      expect(readFileSync(join(a, path)).equals(readFileSync(join(b, path))), path).toBe(true);
    }
    expect(filesA.some((path) => /-[\w-]{8}\.(js|css)$/.test(path))).toBe(true);
  }, 60_000);
});

describe('built page', () => {
  test('has the policy, hashes that match the files, and no inline code', () => {
    const out = join(scratch(), 'web');
    execFileSync(
      'bash',
      [join(__dirname, '..', '..', 'build', 'build.sh'), '0.0.0', '0.0.0', 'release-1', out],
      {
        stdio: 'pipe',
      },
    );
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).not.toMatch(/'unsafe-(inline|eval)'/);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(html).not.toMatch(/<style|\sstyle=/);
    const tags = [
      ...html.matchAll(
        /<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"[^>]*integrity="(sha384-[^"]+)"/g,
      ),
    ];
    expect(tags.length).toBeGreaterThanOrEqual(2);
    for (const [, reference, integrity] of tags) {
      const file = readFileSync(join(out, (reference as string).replace(/^\//, '')));
      expect(integrity, reference).toBe(
        `sha384-${createHash('sha384').update(file).digest('base64')}`,
      );
    }
    expect(readdirSync(out)).toContain('sw.js');
  }, 60_000);
});
