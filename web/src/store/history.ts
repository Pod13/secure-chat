// What the person sees in each Conversation, kept in the encrypted vault: the messages (with
// replies, edits and reactions applied) and each own message's delivery status. Ids already seen
// are kept too, so a replayed message stays ignored after a restart.

import type { Conversation, MessageView } from '../crypto/messagetypes';
import { emptyConversation } from '../crypto/messagetypes';
import type { Vault } from './vault';

export type MessageState = 'sending' | 'sent' | 'delivered' | 'expired';
export interface MessageStatus {
  state: MessageState;
  /** When the message was first sent, in milliseconds. */
  at: number;
}

export interface ViewState {
  conversation: Conversation;
  statuses: Map<string, MessageStatus>;
}

interface StoredMessage extends Omit<MessageView, 'reactions'> {
  reactions: [string, string[]][];
}
interface Stored {
  messages: StoredMessage[];
  order: string[];
  seen: string[];
  statuses: [string, MessageStatus][];
}

const KEY = 'view:';

function toStored(view: ViewState): Stored {
  const { conversation } = view;
  return {
    messages: [...conversation.messages.values()].map((m) => ({
      ...m,
      reactions: [...m.reactions].map(([emoji, people]) => [emoji, [...people]]),
    })),
    order: [...conversation.order],
    seen: [...conversation.seen],
    statuses: [...view.statuses],
  };
}

function fromStored(stored: Stored): ViewState {
  const messages = new Map(
    stored.messages.map((m): [string, MessageView] => [
      m.id,
      { ...m, reactions: new Map(m.reactions.map(([emoji, people]) => [emoji, new Set(people)])) },
    ]),
  );
  return {
    conversation: { messages, order: stored.order, seen: new Set(stored.seen) },
    statuses: new Map(stored.statuses),
  };
}

export class History {
  constructor(private readonly vault: Vault) {}

  async load(conversation: string): Promise<ViewState> {
    const stored = await this.vault.get(KEY + conversation);
    if (stored === undefined) return { conversation: emptyConversation(), statuses: new Map() };
    return fromStored(JSON.parse(new TextDecoder().decode(stored)) as Stored);
  }

  async save(conversation: string, view: ViewState): Promise<void> {
    await this.vault.put(
      KEY + conversation,
      new TextEncoder().encode(JSON.stringify(toStored(view))),
    );
  }
}
