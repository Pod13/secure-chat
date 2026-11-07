import { describe, expect, test } from 'vitest';

import { MessengerError, Messenger } from '../src/net/delivery';
import { RETENTION_MS } from '../src/net/expiry';
import { Outbox } from '../src/net/outbox';
import { webRandom } from '../src/ports';
import { History } from '../src/store/history';
import { FakeRelay, pairUp, person, tokenFor, type Person } from './support/people';

function messengerFor(who: Person) {
  return new Messenger({
    conversations: who.conversations,
    outbox: new Outbox(who.vault, webRandom),
    api: who.relay.api(),
    history: new History(who.vault),
    device: who.device,
    random: webRandom,
    clock: who.clock,
  });
}

/** Alice and Bob in a started conversation, each with a messenger, and a way to pump the relay. */
async function chat() {
  const setup = await pairUp();
  const people = { alice: setup.alice, bob: setup.bob };
  const alice = messengerFor(setup.alice);
  const bob = messengerFor(setup.bob);
  const bobToken = (await setup.alice.conversations.get(setup.started.id))?.peerTokens[0] as string;
  async function pump(): Promise<void> {
    for (const envelope of setup.relay.take(bobToken)) {
      await bob.receive(await people.bob.conversations.handle(envelope));
    }
    for (const envelope of setup.relay.take(tokenFor(0))) {
      await alice.receive(await people.alice.conversations.handle(envelope));
    }
  }
  return {
    ...setup,
    alice,
    bob,
    setupBob: people.bob,
    clock: people.alice.clock,
    bobToken,
    id: setup.started.id,
    pump,
  };
}

const text = (body: string) => ({ kind: 'text' as const, text: body });

describe('sending while both are online', () => {
  test('the message arrives, and the sender sees it go from sent to delivered', async () => {
    const { alice, bob, id, pump } = await chat();
    const messageId = await alice.send(id, text('hello Bob'));
    expect((await alice.view(id)).statuses.get(messageId)?.state).toBe('sent');
    await pump(); // Bob receives and sends his receipt
    await pump(); // Alice receives the receipt
    expect((await alice.view(id)).statuses.get(messageId)?.state).toBe('delivered');
    const seen = (await bob.view(id)).conversation;
    expect(seen.messages.get(messageId)).toMatchObject({ text: 'hello Bob', author: 'them' });
    expect((await alice.view(id)).conversation.messages.get(messageId)?.author).toBe('me');
  });

  test('messages arrive in the order they were sent, once each', async () => {
    const { alice, bob, id, pump } = await chat();
    const sent = [];
    for (const word of ['one', 'two', 'three']) sent.push(await alice.send(id, text(word)));
    await pump();
    await pump();
    const view = (await bob.view(id)).conversation;
    expect(view.order).toEqual(sent);
    expect(sent.map((m) => view.messages.get(m)?.text)).toEqual(['one', 'two', 'three']);
  });
});

describe('reactions, edits and replies', () => {
  test('reactions and edits are delivered and applied', async () => {
    const { alice, bob, id, pump } = await chat();
    const first = await alice.send(id, text('draft'));
    await pump();
    await bob.send(id, { kind: 'reaction', to: first, emoji: '👍', remove: false });
    await pump();
    expect([
      ...((await alice.view(id)).conversation.messages.get(first)?.reactions.get('👍') ?? []),
    ]).toEqual(['them']);
    await alice.send(id, { kind: 'edit', to: first, text: 'final' });
    await pump();
    expect((await bob.view(id)).conversation.messages.get(first)).toMatchObject({
      text: 'final',
      edited: true,
    });
  });

  test('replies are delivered with the message they answer', async () => {
    const { alice, bob, id, pump } = await chat();
    const first = await alice.send(id, text('question?'));
    await pump();
    const answer = await bob.send(id, { kind: 'reply', to: first, text: 'answer' });
    await pump();
    await pump();
    expect((await alice.view(id)).conversation.messages.get(answer)).toMatchObject({
      text: 'answer',
      replyTo: first,
    });
    expect((await bob.view(id)).statuses.get(answer)?.state).toBe('delivered');
  });

  test('only messages with text are acknowledged, and receipts are not acknowledged', async () => {
    const { alice, bob, setupBob, relay, bobToken, id } = await chat();
    const first = await alice.send(id, text('hi'));
    await alice.send(id, { kind: 'edit', to: first, text: 'hi!' });
    for (const envelope of relay.take(bobToken)) {
      await bob.receive(await setupBob.conversations.handle(envelope));
    }
    expect(relay.queues.get(tokenFor(0))).toHaveLength(1); // one receipt, for the text only
  });
});

describe('sending while the recipient cannot be reached', () => {
  test('a message waits, then goes once the relay is back, exactly once', async () => {
    const { alice, bob, relay, bobToken, id, pump } = await chat();
    relay.down.add(bobToken);
    const messageId = await alice.send(id, text('are you there?'));
    expect((await alice.view(id)).statuses.get(messageId)?.state).toBe('sending');
    await alice.flush();
    expect((await alice.view(id)).statuses.get(messageId)?.state).toBe('sending');
    relay.down.delete(bobToken);
    await alice.flush();
    await alice.flush(); // nothing left to send the second time
    expect((await alice.view(id)).statuses.get(messageId)?.state).toBe('sent');
    expect(relay.queues.get(bobToken)).toHaveLength(1);
    await pump();
    expect((await bob.view(id)).conversation.order).toEqual([messageId]);
  });
});

describe('ordering under failures', () => {
  test('a hiccup on the earlier message does not let the later one overtake it', async () => {
    const { alice, relay, bobToken, id } = await chat();
    relay.down.add(bobToken);
    await alice.send(id, text('first'));
    await alice.send(id, text('second'));
    relay.down.delete(bobToken);
    relay.failNext = 1;
    await alice.flush();
    expect(relay.queues.get(bobToken) ?? []).toHaveLength(0);
    await alice.flush();
    expect(relay.queues.get(bobToken)).toHaveLength(2);
  });

  test('later messages do not overtake an earlier one that is stuck', async () => {
    const { alice, relay, bobToken, id } = await chat();
    relay.down.add(bobToken);
    await alice.send(id, text('first'));
    await alice.send(id, text('second'));
    relay.down.delete(bobToken);
    await alice.flush();
    expect(relay.queues.get(bobToken)).toHaveLength(2);
  });

  test("a reply written before the other side's address arrives waits for it", async () => {
    const relay = new FakeRelay();
    const alice = await person(relay, 'alice');
    const bob = await person(relay, 'bob');
    relay.invites.set('INVITE', [
      { deliveryToken: tokenFor(0), keyPackages: [alice.device.keyPackage()] },
    ]);
    const started = await bob.conversations.start('INVITE');
    const [welcome, hello] = relay.take(tokenFor(0));
    const aliceMessenger = messengerFor(alice);
    await aliceMessenger.receive(await alice.conversations.handle(welcome as Uint8Array));
    const waiting = await aliceMessenger.send(started.id, text('hi Bob'));
    expect((await aliceMessenger.view(started.id)).statuses.get(waiting)?.state).toBe('sending');
    await aliceMessenger.receive(await alice.conversations.handle(hello as Uint8Array));
    await aliceMessenger.flush();
    expect((await aliceMessenger.view(started.id)).statuses.get(waiting)?.state).toBe('sent');
  });
});

describe('expiry', () => {
  test('a message not delivered within the retention period is marked expired', async () => {
    const { alice, relay, bobToken, id, clock } = await chat();
    relay.down.add(bobToken);
    const stuck = await alice.send(id, text('never arrives'));
    clock.advance(RETENTION_MS - 1);
    expect(await alice.sweepExpired()).toEqual([]);
    clock.advance(1);
    expect(await alice.sweepExpired()).toEqual([stuck]);
    expect((await alice.view(id)).statuses.get(stuck)?.state).toBe('expired');
    relay.down.delete(bobToken);
    await alice.flush();
    expect(relay.queues.get(bobToken) ?? []).toHaveLength(0); // an expired message is not sent late
    expect(await alice.sweepExpired()).toEqual([]);
  });

  test('delivered messages never expire', async () => {
    const { alice, id, pump, clock } = await chat();
    const messageId = await alice.send(id, text('hi'));
    await pump();
    await pump();
    clock.advance(RETENTION_MS * 2);
    expect(await alice.sweepExpired()).toEqual([]);
    expect((await alice.view(id)).statuses.get(messageId)?.state).toBe('delivered');
  });
});

describe('mistakes', () => {
  test('writing to a conversation that does not exist is refused', async () => {
    const { alice } = await chat();
    await expect(alice.send('00'.repeat(16), text('x'))).rejects.toMatchObject({
      code: 'unknown_conversation',
    });
    expect(new MessengerError('unknown_conversation').name).toBe('MessengerError');
  });

  test('incoming events that carry no message change nothing', async () => {
    const { alice, id } = await chat();
    await alice.receive({ kind: 'ignored' });
    await alice.receive({ kind: 'changed', conversation: id });
    await alice.receive({ kind: 'joined', conversation: id });
    expect((await alice.view(id)).conversation.order).toEqual([]);
  });

  test('a receipt for something that was never sent is ignored', async () => {
    const { alice, bob, id, pump } = await chat();
    const wire = {
      v: 1 as const,
      id: 'f'.repeat(32),
      at: 1,
      content: { kind: 'delivered' as const, to: 'e'.repeat(32) },
    };
    await alice.receive({ kind: 'message', conversation: id, wire });
    await bob.receive({ kind: 'ignored' });
    await pump();
    expect((await alice.view(id)).statuses.size).toBe(0);
  });
});

describe('what is and is not tracked', () => {
  test('receipts are never shown or tracked as messages', async () => {
    const { alice, bob, id, pump } = await chat();
    const sent = await alice.send(id, text('hi'));
    await pump();
    const bobView = await bob.view(id);
    expect(bobView.statuses.size).toBe(0);
    expect(bobView.conversation.order).toEqual([sent]);
    expect((await alice.view(id)).statuses.size).toBe(1);
  });

  test('a late send never downgrades a message already known to be delivered', async () => {
    const { alice, relay, bobToken, id } = await chat();
    relay.down.add(bobToken);
    const messageId = await alice.send(id, text('hi'));
    const receipt = {
      v: 1 as const,
      id: 'a'.repeat(32),
      at: 1,
      content: { kind: 'delivered' as const, to: messageId },
    };
    await alice.receive({ kind: 'message', conversation: id, wire: receipt });
    relay.down.delete(bobToken);
    await alice.flush();
    expect((await alice.view(id)).statuses.get(messageId)?.state).toBe('delivered');
  });

  test('a receipt for a message given up on as expired corrects it to delivered', async () => {
    const { alice, relay, bobToken, id, clock } = await chat();
    relay.down.add(bobToken);
    const messageId = await alice.send(id, text('hi'));
    clock.advance(RETENTION_MS);
    await alice.sweepExpired();
    const receipt = {
      v: 1 as const,
      id: 'b'.repeat(32),
      at: 1,
      content: { kind: 'delivered' as const, to: messageId },
    };
    await alice.receive({ kind: 'message', conversation: id, wire: receipt });
    expect((await alice.view(id)).statuses.get(messageId)?.state).toBe('delivered');
  });
});

describe('receipts, continued', () => {
  test('a repeated receipt changes nothing', async () => {
    const { alice, id, pump } = await chat();
    const messageId = await alice.send(id, text('hi'));
    await pump();
    const before = await alice.view(id);
    const receipt = {
      v: 1 as const,
      id: 'c'.repeat(32),
      at: 1,
      content: { kind: 'delivered' as const, to: messageId },
    };
    await alice.receive({ kind: 'message', conversation: id, wire: receipt });
    expect((await alice.view(id)).statuses).toEqual(before.statuses);
  });
});

describe('one unreachable contact does not hold up the others', () => {
  test('Carol still gets her message while Bob is unreachable', async () => {
    const relay = new FakeRelay();
    const alice = await person(relay, 'alice');
    const bob = await person(relay, 'bob');
    const carol = await person(relay, 'carol');
    relay.invites.set('FOR-BOB', [
      { deliveryToken: tokenFor(0), keyPackages: [alice.device.keyPackage()] },
    ]);
    relay.invites.set('FOR-CAROL', [
      { deliveryToken: tokenFor(1), keyPackages: [alice.device.keyPackage()] },
    ]);
    const withBob = await bob.conversations.start('FOR-BOB');
    const withCarol = await carol.conversations.start('FOR-CAROL');
    for (const token of [tokenFor(0), tokenFor(1)]) {
      for (const envelope of relay.take(token)) await alice.conversations.handle(envelope);
    }
    const messenger = messengerFor(alice);
    const bobTokens = (await alice.conversations.get(withBob.id))?.peerTokens as string[];
    const carolTokens = (await alice.conversations.get(withCarol.id))?.peerTokens as string[];
    relay.down.add(bobTokens[0] as string);
    await messenger.send(withBob.id, text('for Bob'));
    const toCarol = await messenger.send(withCarol.id, text('for Carol'));
    expect(relay.queues.get(carolTokens[0] as string)).toHaveLength(1);
    expect((await messenger.view(withCarol.id)).statuses.get(toCarol)?.state).toBe('sent');
    expect(relay.queues.get(bobTokens[0] as string) ?? []).toHaveLength(0);
  });
});
