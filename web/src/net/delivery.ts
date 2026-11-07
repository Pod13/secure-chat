// Sending and receiving messages in a Conversation (FR-011, FR-012, FR-015). A message is
// encrypted once, its new encryption state is saved, and the ciphertext waits in the encrypted
// outbox until the relay accepts it for every Device of the other person. Retrying resends the
// same ciphertext, and receivers ignore a message they have already read, so nothing duplicates.
// "Delivered" is a receipt the other Device sends inside the encrypted conversation: the relay
// never learns whether or when anything was read.

import type { Conversations, Incoming } from '../crypto/conversation';
import type { Device } from '../crypto/bridge';
import {
  receive as applyMessage,
  encodeMessage,
  type Content,
  type Wire,
} from '../crypto/messagetypes';
import type { Clock, Random } from '../ports';
import { History, type MessageState, type ViewState } from '../store/history';
import { fromBase64Url, toBase64Url } from './base64';
import { expiredIds } from './expiry';
import type { Outbox } from './outbox';

export type MessengerErrorCode = 'unknown_conversation';

export class MessengerError extends Error {
  constructor(readonly code: MessengerErrorCode) {
    super(code);
    this.name = 'MessengerError';
  }
}

export interface MessengerDeps {
  conversations: Conversations;
  outbox: Outbox;
  api: { deliver(token: string, ciphertext: Uint8Array): Promise<void> };
  history: History;
  device: Device;
  random: Random;
  clock: Clock;
}

/** What a person can write; addresses and receipts are produced by the app itself. */
export type Writable = Exclude<Content, { kind: 'endpoints' } | { kind: 'delivered' }>;

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

interface Pending {
  conversation: string;
  ciphertext: string;
}

export class Messenger {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: MessengerDeps) {}

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job);
    this.tail = run.catch(() => undefined);
    return run;
  }

  view(conversation: string): Promise<ViewState> {
    return this.deps.history.load(conversation);
  }

  /** Writes a message. It is stored and encrypted at once; delivery is tried straight away. */
  async send(conversation: string, content: Writable): Promise<string> {
    const id = await this.serial(() => this.queue(conversation, content, true));
    await this.flush();
    return id;
  }

  /** Encrypts, saves the new state and queues the ciphertext. `shown` puts it in the view. */
  private async queue(conversation: string, content: Content, shown: boolean): Promise<string> {
    const { conversations, device, outbox, random, clock, history } = this.deps;
    const record = await conversations.get(conversation);
    if (record === undefined) throw new MessengerError('unknown_conversation');
    const wire: Wire = { v: 1, id: hex(random.bytes(16)), at: clock.nowMs(), content };
    const ciphertext = device.encrypt(record.groupId, encodeMessage(wire));
    await conversations.saveState();
    if (shown) {
      const view = await history.load(conversation);
      view.conversation = applyMessage(view.conversation, 'me', wire);
      view.statuses.set(wire.id, { state: 'sending', at: wire.at });
      await history.save(conversation, view);
    }
    const pending: Pending = { conversation, ciphertext: toBase64Url(ciphertext) };
    await outbox.enqueue(new TextEncoder().encode(JSON.stringify(pending)), wire.id);
    return wire.id;
  }

  /**
   * Sends waiting messages. Within one conversation they go in order and stop at the first one
   * the relay will not take; other conversations are not held up by it.
   */
  flush(): Promise<void> {
    return this.serial(async () => {
      const blocked = new Set<string>();
      for (const item of await this.deps.outbox.pending()) {
        const pending = JSON.parse(new TextDecoder().decode(item.payload)) as Pending;
        if (blocked.has(pending.conversation)) continue;
        if (!(await this.deliverOne(item.id, pending))) blocked.add(pending.conversation);
      }
    });
  }

  private async deliverOne(id: string, { conversation, ciphertext }: Pending): Promise<boolean> {
    const record = await this.deps.conversations.get(conversation);
    if (record === undefined || record.peerTokens.length === 0) return false;
    try {
      for (const token of record.peerTokens) {
        await this.deps.api.deliver(token, fromBase64Url(ciphertext) as Uint8Array);
      }
    } catch {
      return false; // Unreachable for now: the message stays queued and is tried again later.
    }
    await this.deps.outbox.markSent(id);
    await this.setState(conversation, id, 'sent');
    return true;
  }

  /**
   * Moves a message forward: sending to sent, and anything unfinished to delivered. A receipt is
   * proof of delivery, so it also corrects a message wrongly given up on as expired.
   */
  private async setState(conversation: string, id: string, state: MessageState): Promise<void> {
    const view = await this.deps.history.load(conversation);
    const current = view.statuses.get(id)?.state;
    const allowed = state === 'delivered' ? current !== 'delivered' : current === 'sending';
    if (current === undefined || !allowed) return;
    view.statuses.set(id, { state, at: (view.statuses.get(id) as { at: number }).at });
    await this.deps.history.save(conversation, view);
  }

  /** Applies what the conversation layer made of an envelope. */
  receive(incoming: Incoming): Promise<void> {
    return this.serial(async () => {
      if (incoming.kind !== 'message') return;
      const { wire, conversation } = incoming;
      if (wire.content.kind === 'delivered') {
        await this.setState(conversation, wire.content.to, 'delivered');
        return;
      }
      const view = await this.deps.history.load(conversation);
      view.conversation = applyMessage(view.conversation, 'them', wire);
      await this.deps.history.save(conversation, view);
      if (wire.content.kind === 'text' || wire.content.kind === 'reply') {
        await this.queue(conversation, { kind: 'delivered', to: wire.id }, false);
      }
    }).then(() => this.flush());
  }

  /** Marks messages the relay can no longer hold; returns their ids so the person is told. */
  sweepExpired(): Promise<string[]> {
    return this.serial(async () => {
      const found: string[] = [];
      for (const record of await this.deps.conversations.list()) {
        const view = await this.deps.history.load(record.id);
        const ids = expiredIds(view.statuses, this.deps.clock.nowMs());
        for (const id of ids) {
          view.statuses.set(id, { ...(view.statuses.get(id) as { at: number }), state: 'expired' });
          await this.deps.outbox.markSent(id);
        }
        if (ids.length > 0) await this.deps.history.save(record.id, view);
        found.push(...ids);
      }
      return found;
    });
  }
}
