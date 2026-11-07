// Frames the server sends (specs/001-secure-realtime-chat/contracts/realtime-frames.md). Every
// frame is checked against the same limits as the JSON schemas in contracts-schema/ before the
// app sees it; anything else is rejected.

import { fromBase64Url, toBase64Url } from './base64';

export const MAX_ACK_IDS = 100;
const MAX_SERVER_FRAME_CHARS = 256 * 1024;
const MAX_CIPHERTEXT_CHARS = 174_763;
const MAX_TIME = 4_102_444_800;
const ERROR_CODES = ['invalid_request', 'unauthorized', 'rate_limited', 'too_large'] as const;

export type ServerFrame =
  | { type: 'envelope'; id: Uint8Array; ciphertext: Uint8Array; enqueuedAt: number }
  | { type: 'queue-empty' }
  | { type: 'link-request'; requestId: Uint8Array; devicePublicKey: Uint8Array }
  | { type: 'device-unlinked'; reason: 'unlinked' | 'recovered' }
  | { type: 'error'; code: (typeof ERROR_CODES)[number] };

type Fields = Record<string, unknown>;

/** Required fields are checked one by one, so only extra fields are caught by counting. */
function hasKeys(f: Fields, count: number): boolean {
  return Object.keys(f).length === count;
}

function bytesOf(value: unknown, maxChars: number): Uint8Array | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars) return undefined;
  return fromBase64Url(value);
}

/** Exactly `size` bytes, written as at most `maxChars` characters. */
function fixedBytes(value: unknown, size: number, maxChars: number): Uint8Array | undefined {
  const bytes = bytesOf(value, maxChars);
  return bytes?.length === size ? bytes : undefined;
}

function envelope(f: Fields): ServerFrame | undefined {
  const id = fixedBytes(f.envelope_id, 16, 22);
  const ciphertext = bytesOf(f.ciphertext, MAX_CIPHERTEXT_CHARS);
  const at = f.enqueued_at;
  const timeOk = Number.isInteger(at) && (at as number) >= 0 && (at as number) <= MAX_TIME;
  if (!hasKeys(f, 4)) return undefined;
  if (id === undefined || ciphertext === undefined || !timeOk) return undefined;
  return { type: 'envelope', id, ciphertext, enqueuedAt: at as number };
}

function linkRequest(f: Fields): ServerFrame | undefined {
  const requestId = fixedBytes(f.request_id, 16, 22);
  const devicePublicKey = fixedBytes(f.device_public_key, 32, 43);
  if (!hasKeys(f, 3)) return undefined;
  if (requestId === undefined || devicePublicKey === undefined) return undefined;
  return { type: 'link-request', requestId, devicePublicKey };
}

function queueEmpty(f: Fields): ServerFrame | undefined {
  return hasKeys(f, 1) ? { type: 'queue-empty' } : undefined;
}

function unlinked(f: Fields): ServerFrame | undefined {
  const valid = f.reason === 'unlinked' || f.reason === 'recovered';
  return hasKeys(f, 2) && valid
    ? { type: 'device-unlinked', reason: f.reason as 'unlinked' | 'recovered' }
    : undefined;
}

function errorFrame(f: Fields): ServerFrame | undefined {
  const code = ERROR_CODES.find((c) => c === f.code);
  return hasKeys(f, 2) && code !== undefined ? { type: 'error', code } : undefined;
}

const PARSERS = new Map<string, (f: Fields) => ServerFrame | undefined>([
  ['envelope', envelope],
  ['link-request', linkRequest],
  ['queue-empty', queueEmpty],
  ['device-unlinked', unlinked],
  ['error', errorFrame],
]);

/** Returns the frame, or `undefined` if the text is not exactly one valid server frame. */
export function parseServerFrame(text: string): ServerFrame | undefined {
  if (text.length > MAX_SERVER_FRAME_CHARS) return undefined;
  let value: unknown = null;
  try {
    value = JSON.parse(text);
  } catch {
    // Not JSON: `value` stays null and is refused below.
  }
  if (value === null) return undefined;
  const fields = value as Fields;
  return PARSERS.get(fields.type as string)?.(fields);
}

export function ackFrame(ids: Uint8Array[]): string {
  return JSON.stringify({ type: 'ack', envelope_ids: ids.map(toBase64Url) });
}

export const PING_FRAME = JSON.stringify({ type: 'ping' });
