// What travels inside an end-to-end encrypted application message (FR-013), and how a
// conversation applies it. The server never sees any of this. Everything arriving from another
// person is hostile: decoding accepts only an exact, size-limited shape, and applying a message
// never lets one member change another member's text.

export const MAX_TEXT_CHARS = 4000;
export const MAX_EMOJI_CHARS = 16;
/** A whole message, as bytes, is never larger than this. */
const MAX_WIRE_BYTES = 65_536;
const ID_PATTERN = /^[0-9a-f]{32}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** More than this many Devices per Account is never legitimate. */
export const MAX_ENDPOINTS = 50;

export type Content =
  | { kind: 'text'; text: string }
  | { kind: 'reply'; to: string; text: string }
  | { kind: 'reaction'; to: string; emoji: string; remove: boolean }
  | { kind: 'edit'; to: string; text: string }
  /** Delivery tokens (one per Device) at which the sender can be reached in this Conversation. */
  | { kind: 'endpoints'; tokens: string[] }
  /** The recipient's Device received and decrypted message `to`. */
  | { kind: 'delivered'; to: string };

export interface Wire {
  v: 1;
  /** Chosen by the sender (32 lowercase hex characters); retries reuse it, so nothing duplicates. */
  id: string;
  /** Sender's clock, milliseconds. Display only: arrival order is what orders a conversation. */
  at: number;
  content: Content;
}

export function encodeMessage(message: Wire): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(message));
}

type Fields = Record<string, unknown>;

const isId = (value: unknown): value is string =>
  typeof value === 'string' && ID_PATTERN.test(value);
const hasKeys = (value: Fields, ...keys: string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_CHARS;
const isEmoji = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_EMOJI_CHARS;

interface Shape {
  keys: string[];
  valid(c: Fields): boolean;
}

const isTokens = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= MAX_ENDPOINTS &&
  value.every((token) => typeof token === 'string' && TOKEN_PATTERN.test(token));

const SHAPES = new Map<string, Shape>([
  ['delivered', { keys: ['kind', 'to'], valid: (c) => isId(c.to) }],
  ['endpoints', { keys: ['kind', 'tokens'], valid: (c) => isTokens(c.tokens) }],
  ['text', { keys: ['kind', 'text'], valid: (c) => isText(c.text) }],
  ['reply', { keys: ['kind', 'to', 'text'], valid: (c) => isId(c.to) && isText(c.text) }],
  ['edit', { keys: ['kind', 'to', 'text'], valid: (c) => isId(c.to) && isText(c.text) }],
  [
    'reaction',
    {
      keys: ['kind', 'to', 'emoji', 'remove'],
      valid: (c) => isId(c.to) && isEmoji(c.emoji) && typeof c.remove === 'boolean',
    },
  ],
]);

function contentOf(value: unknown): Content | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const c = value as Fields;
  const shape = SHAPES.get(c.kind as string);
  return shape !== undefined && hasKeys(c, ...shape.keys) && shape.valid(c)
    ? (c as Content)
    : undefined;
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null; // Not UTF-8 or not JSON: refused by the caller.
  }
}

/** The message, or `undefined` if the bytes are not exactly one valid message. */
export function decodeMessage(bytes: Uint8Array): Wire | undefined {
  const value = bytes.length > MAX_WIRE_BYTES ? null : parseJson(bytes);
  if (typeof value !== 'object' || value === null) return undefined;
  const f = value as Fields;
  const content = contentOf(f.content);
  const ok = hasKeys(f, 'v', 'id', 'at', 'content') && f.v === 1 && isId(f.id) && isTime(f.at);
  return ok && content !== undefined
    ? { v: 1, id: f.id as string, at: f.at as number, content }
    : undefined;
}

export interface MessageView {
  id: string;
  author: string;
  at: number;
  text: string;
  replyTo: string | undefined;
  edited: boolean;
  /** Emoji to the set of people who reacted with it. */
  reactions: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface Conversation {
  messages: ReadonlyMap<string, MessageView>;
  /** Message ids in order of arrival. */
  order: readonly string[];
  /** Every id used so far by any kind of message, so replays change nothing. */
  seen: ReadonlySet<string>;
}

export const emptyConversation = (): Conversation => ({
  messages: new Map(),
  order: [],
  seen: new Set(),
});

function withMessage(state: Conversation, view: MessageView, extraSeen: string): Conversation {
  return {
    messages: new Map(state.messages).set(view.id, view),
    order: state.order,
    seen: new Set(state.seen).add(extraSeen),
  };
}

function addText(
  state: Conversation,
  author: string,
  wire: Wire,
  text: string,
  replyTo: string | undefined,
): Conversation {
  const view: MessageView = {
    id: wire.id,
    author,
    at: wire.at,
    text,
    replyTo: replyTo !== undefined && state.messages.has(replyTo) ? replyTo : undefined,
    edited: false,
    reactions: new Map(),
  };
  const next = withMessage(state, view, wire.id);
  return { ...next, order: [...state.order, wire.id] };
}

function edit(
  state: Conversation,
  author: string,
  wire: Wire,
  to: string,
  text: string,
): Conversation {
  const target = state.messages.get(to);
  if (target === undefined || target.author !== author) return state;
  return withMessage(state, { ...target, text, edited: true }, wire.id);
}

function react(
  state: Conversation,
  author: string,
  wire: Wire,
  to: string,
  emoji: string,
  remove: boolean,
): Conversation {
  const target = state.messages.get(to);
  if (target === undefined) return state;
  const reactions = new Map(target.reactions);
  const people = new Set(reactions.get(emoji));
  if (remove) people.delete(author);
  else people.add(author);
  if (people.size === 0) reactions.delete(emoji);
  else reactions.set(emoji, people);
  return withMessage(state, { ...target, reactions }, wire.id);
}

/** Applies one message from `author`. Ignored messages return the same state object. */
export function receive(state: Conversation, author: string, wire: Wire): Conversation {
  if (state.seen.has(wire.id)) return state;
  const content = wire.content;
  switch (content.kind) {
    case 'text':
      return addText(state, author, wire, content.text, undefined);
    case 'reply':
      return addText(state, author, wire, content.text, content.to);
    case 'edit':
      return edit(state, author, wire, content.to, content.text);
    case 'reaction':
      return react(state, author, wire, content.to, content.emoji, content.remove);
    case 'endpoints':
    case 'delivered':
      return state; // Handled by the conversation and delivery layers; nothing to show.
  }
}
