import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  KEY_FILE,
  addKey,
  revokeKey,
  revokedList,
  trustedList,
  type SigningKeys,
} from '../../build/rotate-signing-key';

const key = (fill: number): string => Buffer.alloc(32, fill).toString('base64url');
const one: SigningKeys = { trusted: { 'release-1': key(1) }, revoked: [] };

describe('addKey', () => {
  test('adds a key without changing the others', () => {
    const next = addKey(one, 'release-2', key(2));
    expect(next.trusted).toEqual({ 'release-1': key(1), 'release-2': key(2) });
    expect(one.trusted).toEqual({ 'release-1': key(1) });
  });

  test('refuses bad ids, bad keys, duplicates and revoked ids', () => {
    expect(() => addKey(one, 'Bad Id', key(2))).toThrow('key id');
    expect(() => addKey(one, '', key(2))).toThrow('key id');
    expect(() => addKey(one, 'release-2', 'short')).toThrow('32 bytes');
    expect(() => addKey(one, 'release-2', key(2).slice(1) + '!')).toThrow('32 bytes');
    expect(() => addKey(one, 'release-1', key(2))).toThrow('already trusted');
    expect(() => addKey(one, 'release-2', key(1))).toThrow('already trusted');
    const revoked = { trusted: one.trusted, revoked: ['old'] };
    expect(() => addKey(revoked, 'old', key(3))).toThrow('revoked and cannot be added');
  });
});

describe('revokeKey', () => {
  const two = addKey(one, 'release-2', key(2));

  test('moves a key from trusted to revoked', () => {
    const next = revokeKey(two, 'release-1');
    expect(next).toEqual({ trusted: { 'release-2': key(2) }, revoked: ['release-1'] });
  });

  test('refuses unknown keys, and revoking the last key', () => {
    expect(() => revokeKey(two, 'nope')).toThrow('not a trusted key');
    expect(() => revokeKey(one, 'release-1')).toThrow('replacement');
    expect(() => revokeKey(one, 'constructor')).toThrow('not a trusted key');
  });
});

describe('lists for the build', () => {
  test('are written the way the build expects', () => {
    const state = { trusted: { a: key(1), b: key(2) }, revoked: ['x', 'y'] };
    expect(trustedList(state)).toBe(`a:${key(1)},b:${key(2)}`);
    expect(revokedList(state)).toBe('x,y');
    expect(trustedList({ trusted: {}, revoked: [] })).toBe('');
    expect(revokedList({ trusted: {}, revoked: [] })).toBe('');
  });

  test('the committed key file is valid and contains no revoked key among the trusted ones', () => {
    const file = JSON.parse(readFileSync(KEY_FILE, 'utf8')) as SigningKeys;
    expect(Object.keys(file).sort()).toEqual(['revoked', 'trusted']);
    for (const id of file.revoked) expect(file.trusted).not.toHaveProperty(id);
  });
});

describe('command line', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'keys-')), 'signing-keys.json');
  const run = (...args: string[]): string =>
    execFileSync('node', [join(__dirname, '..', '..', 'build', 'rotate-signing-key.ts'), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SIGNING_KEYS_FILE: file },
    });

  test('add, revoke and print against a copy of the key file', () => {
    writeFileSync(file, readFileSync(KEY_FILE));
    run('add', 'cli-a', key(7));
    run('add', 'cli-b', key(8));
    run('revoke', 'cli-a');
    expect(run('trusted')).toContain(`cli-b:${key(8)}`);
    expect(run('trusted')).not.toContain('cli-a');
    expect(run('revoked')).toContain('cli-a');
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
  });

  test('a bad command fails with a usage message', () => {
    expect(() => run('nonsense')).toThrow(/usage/);
    expect(() => run('add', 'only-id')).toThrow(/usage/);
  });
});
