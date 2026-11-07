import { describe, expect, test } from 'vitest';

import { checkTrustedTypes } from '../src/app/trustedTypes';

describe('checkTrustedTypes', () => {
  test('enforced: the browser supports Trusted Types and a string sink is refused', () => {
    const probe = () => {
      throw new TypeError('This document requires TrustedHTML assignment');
    };
    expect(checkTrustedTypes(true, probe)).toBe('enforced');
  });

  test('not enforced: the browser supports it but the sink accepted a string (policy missing)', () => {
    expect(checkTrustedTypes(true, () => undefined)).toBe('not_enforced');
  });

  test('unsupported browsers are reported as such and the sink is not even tried', () => {
    let tried = false;
    expect(checkTrustedTypes(false, () => (tried = true))).toBe('unsupported');
    expect(tried).toBe(false);
  });
});
