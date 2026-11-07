import { describe, expect, test } from 'vitest';

import { ConversationError } from '../src/crypto/conversation';
import { MAX_ENDPOINTS, decodeMessage, encodeMessage } from '../src/crypto/messagetypes';
import { MemoryStore } from './fakes';
import { FakeRelay, pairUp, person, tokenFor } from './support/people';

describe('starting a conversation from an Invite', () => {
  test("Bob's welcome and first message let Alice join and learn how to reach Bob", async () => {
    const { alice, bob, started, received } = await pairUp();
    expect(received.map((r) => r.kind)).toEqual(['joined', 'endpoints']);
    const forAlice = await alice.conversations.get(started.id);
    expect(forAlice?.peerTokens).toHaveLength(1);
    expect(forAlice?.peerTokens).toEqual((await bob.conversations.get(started.id))?.ownTokens);
    expect((await bob.conversations.get(started.id))?.peerTokens).toEqual([tokenFor(0)]);
  });

  test('both sides list the conversation and keep their state in the vault', async () => {
    const { alice, bob, started } = await pairUp();
    expect((await alice.conversations.list()).map((c) => c.id)).toEqual([started.id]);
    expect((await bob.conversations.list()).map((c) => c.id)).toEqual([started.id]);
    expect(await alice.vault.get('mls-state')).toBeDefined();
    expect(await bob.vault.get('mls-state')).toBeDefined();
  });

  test('later messages from Bob reach Alice as text', async () => {
    const { relay, alice, bob, started } = await pairUp();
    const wire = {
      v: 1 as const,
      id: 'a'.repeat(32),
      at: 5,
      content: { kind: 'text' as const, text: 'hi Alice' },
    };
    const cipher = bob.device.encrypt(started.groupId, encodeMessage(wire));
    await relay.api().deliver(tokenFor(0), cipher);
    const [envelope] = relay.take(tokenFor(0));
    const incoming = await alice.conversations.handle(envelope as Uint8Array);
    expect(incoming).toMatchObject({ kind: 'message', conversation: started.id });
    expect(incoming.kind === 'message' && decodeMessage(encodeMessage(incoming.wire))).toEqual(
      wire,
    );
  });
});

describe('hostile or broken input', () => {
  test('junk and replayed envelopes are ignored without changing anything', async () => {
    const { relay, alice, bob, started } = await pairUp();
    expect(await alice.conversations.handle(Uint8Array.of(1, 2, 3))).toEqual({ kind: 'ignored' });
    const cipher = bob.device.encrypt(
      started.groupId,
      encodeMessage({ v: 1, id: 'b'.repeat(32), at: 1, content: { kind: 'text', text: 'once' } }),
    );
    await relay.api().deliver(tokenFor(0), cipher);
    const [envelope] = relay.take(tokenFor(0));
    expect((await alice.conversations.handle(envelope as Uint8Array)).kind).toBe('message');
    expect(await alice.conversations.handle(envelope as Uint8Array)).toEqual({ kind: 'ignored' });
  });

  test('a message that is not valid application content is ignored', async () => {
    const { relay, alice, bob, started } = await pairUp();
    const cipher = bob.device.encrypt(started.groupId, new TextEncoder().encode('not a message'));
    await relay.api().deliver(tokenFor(0), cipher);
    const [envelope] = relay.take(tokenFor(0));
    expect(await alice.conversations.handle(envelope as Uint8Array)).toEqual({ kind: 'ignored' });
  });

  test('an invite that returns no Devices is refused', async () => {
    const relay = new FakeRelay();
    const bob = await person(relay, 'bob');
    relay.invites.set('EMPTY', []);
    await expect(bob.conversations.start('EMPTY')).rejects.toBeInstanceOf(ConversationError);
  });

  test('an unknown conversation is simply absent', async () => {
    const { alice } = await pairUp();
    expect(await alice.conversations.get('00'.repeat(16))).toBeUndefined();
  });
});

describe('people with more than one Device', () => {
  async function twoDevices() {
    const relay = new FakeRelay();
    const first = await person(relay, 'alice-1');
    const second = await person(relay, 'alice-2');
    const bob = await person(relay, 'bob');
    relay.invites.set('INVITE', [
      { deliveryToken: tokenFor(0), keyPackages: [first.device.keyPackage()] },
      { deliveryToken: tokenFor(1), keyPackages: [second.device.keyPackage()] },
    ]);
    const started = await bob.conversations.start('INVITE');
    return { relay, first, second, bob, started };
  }

  test('every Device joins, and earlier ones learn about later ones', async () => {
    const { relay, first, second, started } = await twoDevices();
    const one = [];
    for (const envelope of relay.take(tokenFor(0)))
      one.push(await first.conversations.handle(envelope));
    const two = [];
    for (const envelope of relay.take(tokenFor(1)))
      two.push(await second.conversations.handle(envelope));
    expect(one.map((i) => i.kind)).toEqual(['joined', 'changed', 'endpoints']);
    expect(two.map((i) => i.kind)).toEqual(['joined', 'endpoints']);
    expect((await first.conversations.get(started.id))?.peerTokens).toHaveLength(1);
    expect(first.device.members(started.groupId)).toHaveLength(3);
  });

  test('a Device that is removed is told and its record is kept for display', async () => {
    const { relay, first, bob, started } = await twoDevices();
    for (const envelope of relay.take(tokenFor(0))) await first.conversations.handle(envelope);
    const index = bob.device
      .members(started.groupId)
      .find((m) => new TextDecoder().decode(m.identity) === 'alice-1');
    const commit = bob.device.removeMember(started.groupId, index?.index as number);
    await relay.api().deliver(tokenFor(0), commit);
    const [envelope] = relay.take(tokenFor(0));
    expect(await first.conversations.handle(envelope as Uint8Array)).toEqual({
      kind: 'removed',
      conversation: started.id,
    });
  });
});

describe('odd situations', () => {
  test('endpoints for a conversation with no record are ignored', async () => {
    const relay = new FakeRelay();
    const alice = await person(relay, 'alice');
    const bob = await person(relay, 'bob');
    relay.invites.set('INVITE', [
      { deliveryToken: tokenFor(0), keyPackages: [alice.device.keyPackage()] },
    ]);
    await bob.conversations.start('INVITE');
    const [welcome, hello] = relay.take(tokenFor(0));
    alice.device.join(welcome as Uint8Array); // joined behind the conversation layer's back
    expect(await alice.conversations.handle(hello as Uint8Array)).toEqual({ kind: 'ignored' });
  });

  test('a conversation whose record has gone is left out of the list', async () => {
    const { alice, started } = await pairUp();
    await alice.vault.delete(`conv:${started.id}`);
    expect(await alice.conversations.list()).toEqual([]);
  });
});

describe('storage failures', () => {
  test('a storage failure is reported, not hidden as a bad envelope', async () => {
    const relay = new FakeRelay();
    const store = new MemoryStore();
    const alice = await person(relay, 'alice', store);
    const bob = await person(relay, 'bob');
    relay.invites.set('INVITE', [
      { deliveryToken: tokenFor(0), keyPackages: [alice.device.keyPackage()] },
    ]);
    await bob.conversations.start('INVITE');
    const [welcome] = relay.take(tokenFor(0));
    store.put = () => Promise.reject(new Error('disk full'));
    await expect(alice.conversations.handle(welcome as Uint8Array)).rejects.toThrow('disk full');
    store.put = MemoryStore.prototype.put.bind(store);
  });
});

describe('what is stored', () => {
  test('Bob keeps the id needed to revoke the token he handed out', async () => {
    const { bob, started } = await pairUp();
    const stored = await bob.conversations.get(started.id);
    expect(stored?.ownTokenIds).toHaveLength(1);
    expect(stored?.ownTokenIds[0]).toMatch(/^id\d+x*$/);
  });

  test('Alice starts with nothing handed out and nothing known until Bob says hello', async () => {
    const relay = new FakeRelay();
    const alice = await person(relay, 'alice');
    const bob = await person(relay, 'bob');
    relay.invites.set('INVITE', [
      { deliveryToken: tokenFor(0), keyPackages: [alice.device.keyPackage()] },
    ]);
    const started = await bob.conversations.start('INVITE');
    const [welcome] = relay.take(tokenFor(0));
    await alice.conversations.handle(welcome as Uint8Array);
    expect(await alice.conversations.get(started.id)).toEqual({
      id: started.id,
      groupId: started.groupId,
      peerTokens: [],
      ownTokens: [],
      ownTokenIds: [],
    });
  });

  test('a fresh vault has no conversations', async () => {
    const relay = new FakeRelay();
    const alice = await person(relay, 'alice');
    expect(await alice.conversations.list()).toEqual([]);
  });
});

describe('what is stored, continued', () => {
  test('errors say what went wrong', async () => {
    const relay = new FakeRelay();
    const bob = await person(relay, 'bob');
    relay.invites.set('EMPTY', []);
    await expect(bob.conversations.start('EMPTY')).rejects.toMatchObject({
      code: 'no_devices',
      name: 'ConversationError',
    });
  });

  test('a peer cannot make Alice remember more than the allowed number of endpoints', async () => {
    const { relay, alice, bob, started } = await pairUp();
    const many = Array.from({ length: MAX_ENDPOINTS }, (_, i) =>
      `${String.fromCharCode(65 + (i % 26))}${i}`.padEnd(43, 'Z'),
    );
    const wire = {
      v: 1 as const,
      id: 'c'.repeat(32),
      at: 1,
      content: { kind: 'endpoints' as const, tokens: many },
    };
    await relay
      .api()
      .deliver(tokenFor(0), bob.device.encrypt(started.groupId, encodeMessage(wire)));
    const [envelope] = relay.take(tokenFor(0));
    await alice.conversations.handle(envelope as Uint8Array);
    expect((await alice.conversations.get(started.id))?.peerTokens).toHaveLength(MAX_ENDPOINTS);
  });
});
