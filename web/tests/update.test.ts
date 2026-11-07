import { describe, expect, test } from 'vitest';

import { needsUpdate, updateRequiredPage } from '../src/sw/update';

const manifest = (minClientVersion: string) => ({
  v: 1 as const,
  version: '9.9.9',
  minClientVersion,
  keyId: 'k',
  trustedKeys: {},
  revokedKeys: [],
  files: {},
});

describe('needsUpdate', () => {
  test('a client below the minimum must update', () => {
    expect(needsUpdate('1.0.0', manifest('1.0.1'))).toBe(true);
    expect(needsUpdate('1.9.9', manifest('2.0.0'))).toBe(true);
    expect(needsUpdate('0.0.0', manifest('0.1.0'))).toBe(true);
  });

  test('a client at or above the minimum may run', () => {
    expect(needsUpdate('1.0.0', manifest('1.0.0'))).toBe(false);
    expect(needsUpdate('1.0.1', manifest('1.0.0'))).toBe(false);
    expect(needsUpdate('2.0.0', manifest('1.9.9'))).toBe(false);
  });
});

describe('updateRequiredPage', () => {
  test('explains the problem, names the version, and has no scripts or styles', () => {
    const page = updateRequiredPage('1.2.0', '1.0.0');
    expect(page).toContain('<title>Update required</title>');
    expect(page).toContain('<h1>An update is required</h1>');
    expect(page).toContain(
      'to keep your messages safe. Close the app completely and open it again to update.</p>',
    );
    expect(page).toContain('1.2.0');
    expect(page).toContain('1.0.0');
    expect(page).not.toMatch(/<script|<style|\sstyle=|on\w+=/i);
  });
});
