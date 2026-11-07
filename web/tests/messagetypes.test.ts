import { describe, expect, test } from 'vitest';

import {
  MAX_EMOJI_CHARS,
  MAX_ENDPOINTS,
  MAX_TEXT_CHARS,
  decodeMessage,
  emptyConversation,
  encodeMessage,
  receive,
  type Wire,
} from '../src/crypto/messagetypes';

const id = (n: number): string => n.toString(16).padStart(32, '0');
const text = (n: number, body: string, at = 1000 + n): Wire => ({
  v: 1,
  id: id(n),
  at,
  content: { kind: 'text', text: body },
});
const decoder = new TextDecoder();
const encoder = new TextEncoder();

describe('encoding', () => {
  test('round-trips every kind of message', () => {
    const all: Wire[] = [
      text(1, 'hello'),
      { v: 1, id: id(2), at: 5, content: { kind: 'reply', to: id(1), text: 'yes' } },
      {
        v: 1,
        id: id(3),
        at: 6,
        content: { kind: 'reaction', to: id(1), emoji: '👍', remove: false },
      },
      {
        v: 1,
        id: id(4),
        at: 7,
        content: { kind: 'reaction', to: id(1), emoji: '👍', remove: true },
      },
      { v: 1, id: id(5), at: 8, content: { kind: 'edit', to: id(1), text: 'hello!' } },
    ];
    for (const message of all) {
      expect(decodeMessage(encodeMessage(message))).toEqual(message);
    }
  });

  test('is JSON text so versions can be told apart', () => {
    expect(JSON.parse(decoder.decode(encodeMessage(text(1, 'hi'))))).toMatchObject({ v: 1 });
  });

  test('text up to the limit is accepted and one more character is not', () => {
    const longest = text(1, 'a'.repeat(MAX_TEXT_CHARS));
    expect(decodeMessage(encodeMessage(longest))).toEqual(longest);
    expect(decodeMessage(encodeMessage(text(1, 'a'.repeat(MAX_TEXT_CHARS + 1))))).toBeUndefined();
  });

  test('emoji up to the limit are accepted and longer ones are not', () => {
    const reaction = (emoji: string): Wire => ({
      v: 1,
      id: id(3),
      at: 1,
      content: { kind: 'reaction', to: id(1), emoji, remove: false },
    });
    expect(decodeMessage(encodeMessage(reaction('x'.repeat(MAX_EMOJI_CHARS))))).toBeDefined();
    expect(decodeMessage(encodeMessage(reaction('x'.repeat(MAX_EMOJI_CHARS + 1))))).toBeUndefined();
    expect(decodeMessage(encodeMessage(reaction('')))).toBeUndefined();
  });
});

describe('decoding hostile input', () => {
  const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
  const good = { v: 1, id: id(1), at: 5, content: { kind: 'text', text: 'hi' } };

  test('rejects anything that is not exactly a known message', () => {
    const bad: unknown[] = [
      null,
      [],
      'text',
      5,
      {},
      { ...good, v: 2 },
      { ...good, extra: 1 },
      { ...good, id: 'short' },
      { ...good, id: [id(1)] },
      { ...good, content: { kind: 'text', text: ['hi'] } },
      { ...good, content: { kind: 'text', txt: 'hi' } },
      { ...good, content: { kind: 'reply', to: [id(1)], text: 'hi' } },
      { ...good, content: { kind: 'reply', too: id(1), text: 'hi' } },
      { ...good, content: { kind: 'reaction', to: id(1), emoji: ['x'], remove: false } },
      { ...good, content: { kind: 'reaction', to: id(1), emoji: 'x', removed: false } },
      { ...good, at: [5] },
      { vee: 1, id: id(1), at: 5, content: good.content },
      { ...good, id: 'G'.repeat(32) },
      { ...good, id: id(255).toUpperCase() },
      { ...good, at: -1 },
      { ...good, at: 1.5 },
      { ...good, at: '5' },
      { ...good, content: null },
      { ...good, content: { kind: 'unknown' } },
      { ...good, content: { kind: 'text' } },
      { ...good, content: { kind: 'text', text: 5 } },
      { ...good, content: { kind: 'text', text: '' } },
      { ...good, content: { kind: 'text', text: 'hi', extra: 1 } },
      { ...good, content: { kind: 'reply', text: 'hi' } },
      { ...good, content: { kind: 'reply', to: 'nope', text: 'hi' } },
      { ...good, content: { kind: 'reaction', to: id(1), emoji: '👍' } },
      { ...good, content: { kind: 'reaction', to: id(1), emoji: '👍', remove: 'yes' } },
      { ...good, content: { kind: 'edit', to: id(1) } },
      { ...good, content: { kind: 'edit', to: id(1), text: '' } },
    ];
    for (const value of bad) {
      expect(decodeMessage(bytes(value)), JSON.stringify(value)).toBeUndefined();
    }
  });
});

describe('decoding hostile input, bytes', () => {
  const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
  const good = { v: 1, id: id(1), at: 5, content: { kind: 'text', text: 'hi' } };

  test('rejects text that is not JSON, not UTF-8, or too large', () => {
    expect(decodeMessage(new TextEncoder().encode('not json'))).toBeUndefined();
    expect(decodeMessage(new Uint8Array([0xff, 0xfe, 0xfd]))).toBeUndefined();
    expect(decodeMessage(new Uint8Array(0))).toBeUndefined();
    expect(decodeMessage(new Uint8Array(70_000).fill(32))).toBeUndefined();
  });

  test('accepts a time of zero', () => {
    expect(decodeMessage(bytes({ ...good, at: 0 }))).toEqual({ ...good, at: 0 });
  });

  test('rejects text that is valid JSON but not valid UTF-8, or valid JSON that is too large', () => {
    const raw = new TextEncoder().encode(JSON.stringify(good));
    const broken = new Uint8Array([
      ...raw.slice(0, raw.length - 6),
      0xff,
      ...raw.slice(raw.length - 6),
    ]);
    expect(decodeMessage(raw)).toBeDefined();
    expect(decodeMessage(broken)).toBeUndefined();
    const padded = new Uint8Array(65_537).fill(32);
    padded.set(raw);
    expect(decodeMessage(padded)).toBeUndefined();
    const limit = new Uint8Array(65_536).fill(32);
    limit.set(raw);
    expect(decodeMessage(limit)).toBeDefined();
  });

  test('accepts the plain good message', () => {
    expect(decodeMessage(bytes(good))).toEqual(good);
  });
});

describe('receiving messages', () => {
  const alice = 'alice';
  const bob = 'bob';

  test('stores text in order of arrival and keeps its author and time', () => {
    let state = emptyConversation();
    state = receive(state, alice, text(1, 'one'));
    state = receive(state, bob, text(2, 'two'));
    expect(state.order).toEqual([id(1), id(2)]);
    expect(state.messages.get(id(2))).toMatchObject({ author: bob, text: 'two', at: 1002 });
  });

  test('the same message twice is stored once', () => {
    let state = receive(emptyConversation(), alice, text(1, 'one'));
    state = receive(state, alice, text(1, 'one again'));
    expect(state.order).toEqual([id(1)]);
    expect(state.messages.get(id(1))?.text).toBe('one');
  });

  test('a reply keeps its target when the target is known, and loses it when it is not', () => {
    let state = receive(emptyConversation(), alice, text(1, 'question'));
    state = receive(state, bob, {
      v: 1,
      id: id(2),
      at: 5,
      content: { kind: 'reply', to: id(1), text: 'answer' },
    });
    state = receive(state, bob, {
      v: 1,
      id: id(3),
      at: 6,
      content: { kind: 'reply', to: id(99), text: 'orphan' },
    });
    expect(state.messages.get(id(2))?.replyTo).toBe(id(1));
    expect(state.messages.get(id(3))).toMatchObject({ text: 'orphan' });
    expect(state.messages.get(id(3))?.replyTo).toBeUndefined();
  });

  test('only the author can edit, and an edit marks the message as edited', () => {
    let state = receive(emptyConversation(), alice, text(1, 'original'));
    const edit = (n: number, to: number, body: string): Wire => ({
      v: 1,
      id: id(n),
      at: 50,
      content: { kind: 'edit', to: id(to), text: body },
    });
    const byOther = receive(state, bob, edit(2, 1, 'hijacked'));
    expect(byOther.messages.get(id(1))).toMatchObject({ text: 'original', edited: false });
    state = receive(state, alice, edit(3, 1, 'fixed'));
    expect(state.messages.get(id(1))).toMatchObject({ text: 'fixed', edited: true });
    expect(state.order).toEqual([id(1)]);
  });
});

describe('receiving edits', () => {
  const alice = 'alice';

  test('an edit of an unknown message is ignored and is not stored as a message', () => {
    const state = receive(emptyConversation(), alice, {
      v: 1,
      id: id(2),
      at: 5,
      content: { kind: 'edit', to: id(99), text: 'ghost' },
    });
    expect(state.order).toEqual([]);
  });

  test('an edit cannot change another kind of record or an edit', () => {
    let state = receive(emptyConversation(), alice, text(1, 'original'));
    state = receive(state, alice, {
      v: 1,
      id: id(2),
      at: 5,
      content: { kind: 'edit', to: id(1), text: 'v2' },
    });
    const again = receive(state, alice, {
      v: 1,
      id: id(3),
      at: 6,
      content: { kind: 'edit', to: id(2), text: 'v3' },
    });
    expect(again.messages.get(id(1))?.text).toBe('v2');
  });
});

describe('receiving reactions', () => {
  const alice = 'alice';
  const bob = 'bob';

  test('reactions are added per person and can be removed, and unknown targets are ignored', () => {
    const react = (n: number, to: number, emoji: string, remove: boolean): Wire => ({
      v: 1,
      id: id(n),
      at: n,
      content: { kind: 'reaction', to: id(to), emoji, remove },
    });
    let state = receive(emptyConversation(), alice, text(1, 'hello'));
    state = receive(state, bob, react(2, 1, '👍', false));
    state = receive(state, alice, react(3, 1, '👍', false));
    state = receive(state, bob, react(4, 1, '❤️', false));
    expect([...(state.messages.get(id(1))?.reactions.get('👍') ?? [])].sort()).toEqual([
      alice,
      bob,
    ]);
    state = receive(state, bob, react(5, 1, '👍', true));
    expect([...(state.messages.get(id(1))?.reactions.get('👍') ?? [])]).toEqual([alice]);
    state = receive(state, alice, react(6, 1, '👍', true));
    expect(state.messages.get(id(1))?.reactions.has('👍')).toBe(false);
    expect(state.messages.get(id(1))?.reactions.get('❤️')?.has(bob)).toBe(true);
    const unknown = receive(state, bob, react(7, 99, '👍', false));
    expect(unknown).toBe(state);
    expect(unknown.order).toEqual([id(1)]);
  });
});

describe('receiving reactions, edge cases', () => {
  const alice = 'alice';
  const bob = 'bob';

  test('removing a reaction that was never added changes nothing', () => {
    const state = receive(emptyConversation(), alice, text(1, 'hello'));
    const removed = receive(state, bob, {
      v: 1,
      id: id(2),
      at: 2,
      content: { kind: 'reaction', to: id(1), emoji: '👍', remove: true },
    });
    expect(removed.messages.get(id(1))?.reactions.size).toBe(0);
  });

  test('receiving never changes the state it was given', () => {
    const before = receive(emptyConversation(), alice, text(1, 'hello'));
    receive(before, bob, {
      v: 1,
      id: id(2),
      at: 2,
      content: { kind: 'reaction', to: id(1), emoji: '👍', remove: false },
    });
    receive(before, alice, {
      v: 1,
      id: id(3),
      at: 3,
      content: { kind: 'edit', to: id(1), text: 'changed' },
    });
    expect(before.messages.get(id(1))).toMatchObject({ text: 'hello', edited: false });
    expect(before.messages.get(id(1))?.reactions.size).toBe(0);
    expect(before.order).toEqual([id(1)]);
  });

  test('an id used for a reaction or edit cannot later be reused for a text message', () => {
    let state = receive(emptyConversation(), alice, text(1, 'hello'));
    state = receive(state, bob, {
      v: 1,
      id: id(2),
      at: 2,
      content: { kind: 'reaction', to: id(1), emoji: '👍', remove: false },
    });
    const reused = receive(state, bob, text(2, 'sneaky'));
    expect(reused.order).toEqual([id(1)]);
  });
});

describe('endpoints', () => {
  const token = (n: number): string => String.fromCharCode(65 + (n % 26)).repeat(43);
  const wireWith = (tokens: unknown): Uint8Array =>
    encoder.encode(
      JSON.stringify({ v: 1, id: id(1), at: 1, content: { kind: 'endpoints', tokens } }),
    );

  test('round-trip through encoding', () => {
    const wire: Wire = {
      v: 1,
      id: id(1),
      at: 5,
      content: { kind: 'endpoints', tokens: [token(1)] },
    };
    expect(decodeMessage(encodeMessage(wire))).toEqual(wire);
  });

  test('accept between 1 and 50 well-formed tokens', () => {
    expect(decodeMessage(wireWith([token(1)]))).toBeDefined();
    expect(
      decodeMessage(wireWith(Array.from({ length: MAX_ENDPOINTS }, (_, i) => token(i)))),
    ).toBeDefined();
  });
});

describe('endpoints, refused shapes', () => {
  const token = (n: number): string => String.fromCharCode(65 + (n % 26)).repeat(43);
  const wireWith = (tokens: unknown): Uint8Array =>
    encoder.encode(
      JSON.stringify({ v: 1, id: id(1), at: 1, content: { kind: 'endpoints', tokens } }),
    );

  test.each([
    ['none', []],
    ['too many', Array.from({ length: MAX_ENDPOINTS + 1 }, (_, i) => token(i))],
    ['a short token', ['AAAA']],
    ['a long token', ['A'.repeat(44)]],
    ['a token with other characters', ['!'.repeat(43)]],
    ['a number', [5]],
    ['not a list', 'A'.repeat(43)],
  ])('refuse %s', (_name, tokens) => {
    expect(decodeMessage(wireWith(tokens))).toBeUndefined();
  });

  test('refuse extra fields', () => {
    const body = JSON.stringify({
      v: 1,
      id: id(1),
      at: 1,
      content: { kind: 'endpoints', tokens: [token(1)], extra: 1 },
    });
    expect(decodeMessage(encoder.encode(body))).toBeUndefined();
  });

  test('change nothing in the conversation view', () => {
    const state = emptyConversation();
    const wire: Wire = {
      v: 1,
      id: id(1),
      at: 5,
      content: { kind: 'endpoints', tokens: [token(1)] },
    };
    expect(receive(state, 'alice', wire)).toBe(state);
  });
});

describe('delivery receipts', () => {
  const receipt = (to: unknown, extra: object = {}): Uint8Array =>
    encoder.encode(
      JSON.stringify({ v: 1, id: id(1), at: 1, content: { kind: 'delivered', to, ...extra } }),
    );

  test('round-trip and leave the conversation view alone', () => {
    const wire: Wire = { v: 1, id: id(1), at: 5, content: { kind: 'delivered', to: id(7) } };
    expect(decodeMessage(encodeMessage(wire))).toEqual(wire);
    const state = emptyConversation();
    expect(receive(state, 'bob', wire)).toBe(state);
  });

  test('refuse a bad target or extra fields', () => {
    expect(decodeMessage(receipt('nope'))).toBeUndefined();
    expect(decodeMessage(receipt(5))).toBeUndefined();
    expect(decodeMessage(receipt(id(2), { extra: 1 }))).toBeUndefined();
  });
});
