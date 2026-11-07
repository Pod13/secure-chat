import { describe, expect, test } from 'vitest';

import { RETENTION_MS, expiredIds } from '../src/net/expiry';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
const status = (state: string, at: number) => ({ state, at });

describe('undelivered messages expire after the server keeps them', () => {
  test('the server keeps messages for 30 days', () => {
    expect(RETENTION_MS).toBe(30 * DAY);
  });

  test('a message is not expired until the full retention has passed', () => {
    const statuses = new Map([
      ['fresh', status('sent', NOW - 1 * DAY)],
      ['edge', status('sent', NOW - RETENTION_MS + 1)],
      ['exact', status('sent', NOW - RETENTION_MS)],
      ['old', status('sent', NOW - RETENTION_MS - 1)],
    ]);
    expect(expiredIds(statuses, NOW)).toEqual(['exact', 'old']);
  });

  test('messages that still wait in the outbox expire too', () => {
    const statuses = new Map([['stuck', status('sending', NOW - 40 * DAY)]]);
    expect(expiredIds(statuses, NOW)).toEqual(['stuck']);
  });

  test('delivered and already-expired messages are left alone', () => {
    const statuses = new Map([
      ['done', status('delivered', NOW - 90 * DAY)],
      ['gone', status('expired', NOW - 90 * DAY)],
    ]);
    expect(expiredIds(statuses, NOW)).toEqual([]);
  });
});
