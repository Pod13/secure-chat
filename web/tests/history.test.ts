import { beforeAll, describe, expect, test } from 'vitest';

import { emptyConversation, receive, type Wire } from '../src/crypto/messagetypes';
import { MIN_KDF, createSodium, type Sodium } from '../src/crypto/sodium';
import { webRandom } from '../src/ports';
import { History } from '../src/store/history';
import { createVault } from '../src/store/vault';
import { MemoryStore } from './fakes';

let sodium: Sodium;
beforeAll(async () => {
  sodium = await createSodium(webRandom);
});

const id = (n: number): string => n.toString(16).padStart(32, '0');
const wire = (n: number, content: Wire['content']): Wire => ({ v: 1, id: id(n), at: n, content });

async function make() {
  const store = new MemoryStore();
  const vault = await createVault({ sodium, store, kdf: MIN_KDF }, 'correct horse battery');
  return { history: new History(vault), vault, store };
}

describe('history', () => {
  test('a conversation nobody has written to is empty', async () => {
    const { history } = await make();
    const view = await history.load('c1');
    expect(view.conversation.order).toEqual([]);
    expect(view.statuses.size).toBe(0);
  });

  test('messages, replies, edits, reactions and statuses survive saving and loading', async () => {
    const { history } = await make();
    let state = emptyConversation();
    state = receive(state, 'me', wire(1, { kind: 'text', text: 'hello' }));
    state = receive(state, 'them', wire(2, { kind: 'reply', to: id(1), text: 're: hello' }));
    state = receive(
      state,
      'them',
      wire(3, { kind: 'reaction', to: id(1), emoji: '👍', remove: false }),
    );
    state = receive(state, 'me', wire(4, { kind: 'edit', to: id(1), text: 'hello!' }));
    const statuses = new Map([[id(1), { state: 'sent' as const, at: 1 }]]);
    await history.save('c1', { conversation: state, statuses });
    const loaded = await history.load('c1');
    expect(loaded.conversation.order).toEqual([id(1), id(2)]);
    expect(loaded.conversation.messages.get(id(1))).toMatchObject({ text: 'hello!', edited: true });
    expect(loaded.conversation.messages.get(id(2))?.replyTo).toBe(id(1));
    expect([...(loaded.conversation.messages.get(id(1))?.reactions.get('👍') ?? [])]).toEqual([
      'them',
    ]);
    expect(loaded.conversation.seen.has(id(4))).toBe(true);
    expect(loaded.statuses.get(id(1))).toEqual({ state: 'sent', at: 1 });
  });
});

describe('history, continued', () => {
  test('a replayed message stays ignored after reloading', async () => {
    const { history } = await make();
    const first = wire(1, { kind: 'text', text: 'once' });
    const state = receive(emptyConversation(), 'them', first);
    await history.save('c1', { conversation: state, statuses: new Map() });
    const loaded = await history.load('c1');
    expect(receive(loaded.conversation, 'them', first)).toBe(loaded.conversation);
  });

  test('conversations are kept apart, and stored only in sealed form', async () => {
    const { history, store, vault } = await make();
    const state = receive(
      emptyConversation(),
      'me',
      wire(1, { kind: 'text', text: 'secret words' }),
    );
    await history.save('c1', { conversation: state, statuses: new Map() });
    expect((await history.load('c2')).conversation.order).toEqual([]);
    expect(await vault.get('view:c1')).toBeDefined();
    for (const value of store.entries.values()) {
      expect(Buffer.from(value).toString('latin1')).not.toContain('secret words');
    }
  });
});
