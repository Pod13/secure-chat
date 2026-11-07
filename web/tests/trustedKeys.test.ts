import { describe, expect, test } from 'vitest';

import { toBase64Url } from '../src/net/base64';
import { parseKeys } from '../src/sw/trustedKeys';

const key = (fill: number): string => toBase64Url(new Uint8Array(32).fill(fill));

describe('parseKeys', () => {
  test('reads several well-formed keys', () => {
    const keys = parseKeys(`release-1:${key(1)},release-2:${key(2)}`);
    expect(Object.keys(keys)).toEqual(['release-1', 'release-2']);
    expect(keys['release-2']).toEqual(new Uint8Array(32).fill(2));
  });

  test('drops anything malformed rather than guessing', () => {
    const bad = [
      '',
      'noseparator',
      `Bad_Id:${key(1)}`,
      `${'a'.repeat(33)}:${key(1)}`,
      `:${key(1)}`,
      `ok:${key(1)}:extra`,
      `ok:${toBase64Url(new Uint8Array(31))}`,
      `ok:${toBase64Url(new Uint8Array(33))}`,
      'ok:not base64!',
      'ok:',
    ];
    for (const spec of bad) expect(parseKeys(spec), spec).toEqual({});
  });

  test('keeps the good entries next to bad ones', () => {
    expect(Object.keys(parseKeys(`bad,good:${key(3)},also bad`))).toEqual(['good']);
  });
});
