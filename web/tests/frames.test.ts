import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { fromBase64Url, toBase64Url } from '../src/net/base64';
import { MAX_ACK_IDS, PING_FRAME, ackFrame, parseServerFrame } from '../src/net/frames';

const ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const KEY = 'A'.repeat(43);

describe('base64url', () => {
  test('round-trips and uses the URL alphabet without padding', () => {
    const bytes = Uint8Array.from([251, 255, 190, 0, 1]);
    const text = toBase64Url(bytes);
    expect(text).toBe('-_--AAE');
    expect(fromBase64Url(text)).toEqual(bytes);
    expect(toBase64Url(new Uint8Array())).toBe('');
  });

  test('rejects padding, other alphabets, impossible lengths and non-canonical spellings', () => {
    for (const bad of ['€AAA', 'AAA€', '€', 'AA==', 'A+A', 'A/A', 'A A', 'AAAAA', 'AB', '€']) {
      expect(fromBase64Url(bad), bad).toBeUndefined();
    }
    expect(fromBase64Url('AA')).toEqual(Uint8Array.from([0]));
  });
});

describe('server frames', () => {
  test('every schema example in contracts-schema parses (the client agrees with the contract)', () => {
    const dir = join(__dirname, '..', '..', 'contracts-schema');
    const files = readdirSync(dir).filter(
      (f) => f.startsWith('ws-') && !f.includes('ack') && !f.includes('ping'),
    );
    expect(files.length).toBe(5);
    for (const file of files) {
      const example = (JSON.parse(readFileSync(join(dir, file), 'utf8')) as { examples: unknown[] })
        .examples[0];
      expect(parseServerFrame(JSON.stringify(example)), file).toBeDefined();
    }
  });

  test('an envelope carries decoded bytes', () => {
    const frame = parseServerFrame(
      JSON.stringify({ type: 'envelope', envelope_id: ID, ciphertext: 'AQID', enqueued_at: 7 }),
    );
    expect(frame).toEqual({
      type: 'envelope',
      id: new Uint8Array(16),
      ciphertext: Uint8Array.from([1, 2, 3]),
      enqueuedAt: 7,
    });
  });

  test('the other frame types', () => {
    expect(parseServerFrame('{"type":"queue-empty"}')).toEqual({ type: 'queue-empty' });
    expect(parseServerFrame('{"type":"device-unlinked","reason":"recovered"}')).toEqual({
      type: 'device-unlinked',
      reason: 'recovered',
    });
    expect(parseServerFrame('{"type":"device-unlinked","reason":"unlinked"}')).toBeDefined();
    expect(parseServerFrame('{"type":"error","code":"rate_limited"}')).toEqual({
      type: 'error',
      code: 'rate_limited',
    });
    expect(
      parseServerFrame(
        JSON.stringify({ type: 'link-request', request_id: ID, device_public_key: KEY }),
      ),
    ).toEqual({
      type: 'link-request',
      requestId: new Uint8Array(16),
      devicePublicKey: new Uint8Array(32),
    });
  });
});

describe('frame boundaries', () => {
  const envelope = (extra: object) =>
    JSON.stringify({
      type: 'envelope',
      envelope_id: ID,
      ciphertext: 'AQID',
      enqueued_at: 7,
      ...extra,
    });

  test('limits are inclusive at the contract values', () => {
    expect(parseServerFrame(envelope({ enqueued_at: 4_102_444_800 }))).toBeDefined();
    expect(parseServerFrame(envelope({ enqueued_at: 0 }))).toBeDefined();
    expect(parseServerFrame(envelope({ ciphertext: 'A'.repeat(174_763) }))).toBeDefined();
    const frame = '{"type":"queue-empty"}';
    const maximum = ' '.repeat(256 * 1024 - frame.length) + frame;
    expect(parseServerFrame(maximum)).toBeDefined();
    expect(parseServerFrame(' ' + maximum)).toBeUndefined();
  });

  test('field names must match exactly, not just in number', () => {
    const base = { type: 'envelope', envelope_id: ID, ciphertext: 'AQID' };
    expect(parseServerFrame(JSON.stringify({ ...base, enqueued_aT: 7 }))).toBeUndefined();
    expect(parseServerFrame(JSON.stringify({ ...base, enqueued_at: 7, zzz: 1 }))).toBeUndefined();
    expect(parseServerFrame(JSON.stringify(base))).toBeUndefined();
    expect(parseServerFrame('{"type":"error","cod":"rate_limited"}')).toBeUndefined();
  });

  test('each id field is checked on its own', () => {
    const link = (request: string, key: string) =>
      JSON.stringify({ type: 'link-request', request_id: request, device_public_key: key });
    expect(parseServerFrame(link('AAAA', KEY))).toBeUndefined();
    expect(parseServerFrame(link(ID, 'AAAA'))).toBeUndefined();
    expect(parseServerFrame(link(ID, KEY))).toBeDefined();
    expect(
      parseServerFrame(
        JSON.stringify({
          type: 'envelope',
          envelope_id: ID.repeat(2),
          ciphertext: 'AQID',
          enqueued_at: 1,
        }),
      ),
    ).toBeUndefined();
  });

  test('inherited names are not frame types', () => {
    for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(parseServerFrame(JSON.stringify({ type }))).toBeUndefined();
    }
    expect(parseServerFrame('{"type":5}')).toBeUndefined();
  });
});

describe('invalid server frames', () => {
  test('anything not exactly a valid frame is refused', () => {
    const envelope = { type: 'envelope', envelope_id: ID, ciphertext: 'AQID', enqueued_at: 7 };
    const bad: unknown[] = [
      'not json',
      '[]',
      'null',
      '"envelope"',
      {},
      { type: 'ack', envelope_ids: [] },
      { type: 'nope' },
      { ...envelope, extra: 1 },
      { ...envelope, envelope_id: 'AAAA' },
      { ...envelope, envelope_id: 5 },
      { ...envelope, ciphertext: '' },
      { ...envelope, ciphertext: 'AQ==' },
      { ...envelope, ciphertext: 'x'.repeat(174_764) },
      { ...envelope, enqueued_at: -1 },
      { ...envelope, enqueued_at: 4_102_444_801 },
      { ...envelope, enqueued_at: 1.5 },
      { ...envelope, enqueued_at: '7' },
      { type: 'queue-empty', extra: 1 },
      { type: 'device-unlinked' },
      { type: 'device-unlinked', reason: 'other' },
      { type: 'device-unlinked', reason: 'unlinked', extra: 1 },
      { type: 'error', code: 'mystery' },
      { type: 'error' },
      { type: 'error', code: 'rate_limited', extra: 1 },
      { type: 'link-request', request_id: ID },
      { type: 'link-request', request_id: ID, device_public_key: 'AAAA' },
      { type: 'link-request', request_id: ID, device_public_key: KEY, extra: 1 },
    ];
    for (const value of bad) {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      expect(parseServerFrame(text), text).toBeUndefined();
    }
    expect(parseServerFrame(' '.repeat(256 * 1024 + 1) + '{"type":"queue-empty"}')).toBeUndefined();
  });
});

describe('client frames', () => {
  test('ping and ack are exactly what the server accepts', () => {
    expect(PING_FRAME).toBe('{"type":"ping"}');
    expect(ackFrame([new Uint8Array(16)])).toBe(`{"type":"ack","envelope_ids":["${ID}"]}`);
    expect(MAX_ACK_IDS).toBe(100);
  });
});
