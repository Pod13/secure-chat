// The app's brain, free of any UI framework: it knows which screen applies (no account yet,
// locked, ready), runs sign-up, unlock, invites and messages, and tells the screens when
// something changed. Screens only call these methods and render the snapshot.

import {
  AccountError,
  createAccount,
  loadAccount,
  type Account,
  type AccountDeps,
} from '../crypto/account';
import type { MlsBridge } from '../crypto/bridge';
import type { ConversationRecord } from '../crypto/conversation';
import type { KdfParams, Sodium } from '../crypto/sodium';
import type { ConnectionState } from '../net/socket';
import type { ViewState } from '../store/history';
import { createVault, unlockVault, type Vault } from '../store/vault';
import type { Clock, KeyValueStore, Network, Random } from '../ports';
import type { Writable } from '../net/delivery';
import { Session, type SessionDeps } from './session';
import type { SocketPorts } from '../net/socket';

export type Phase = 'starting' | 'sign-up' | 'locked' | 'recovery-key' | 'ready' | 'unlinked';

export interface ConversationSummary {
  id: string;
  lastText: string | undefined;
}

export interface Snapshot {
  phase: Phase;
  /** Shown once after sign-up and then forgotten. */
  recoveryKey: string | undefined;
  connection: ConnectionState;
  conversations: ConversationSummary[];
  /** Goes up whenever anything may have changed, so open screens know to reload. */
  revision: number;
}

export interface ControllerDeps {
  store: KeyValueStore;
  sodium: Sodium;
  random: Random;
  clock: Clock;
  bridge: MlsBridge;
  network: Network;
  sockets: SocketPorts;
  /** Where this app is served from, used to make invite links. */
  origin: string;
  wsUrl: string;
  /** Lower Argon2id cost; tests only. */
  kdf?: KdfParams;
}

export interface SignUpInput {
  /** An Invite link, or the bare token of an operator's seed Invite. */
  inviteLink: string;
  username: string;
  passcode: string;
  deviceName?: string;
}

const INVITE_LIFETIME_S = 7 * 24 * 60 * 60;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type ControllerErrorCode = 'not_ready' | 'bad_invite_link';

export class ControllerError extends Error {
  constructor(readonly code: ControllerErrorCode) {
    super(code);
    this.name = 'ControllerError';
  }
}

export interface InviteParts {
  /** Starts a conversation with the person who made the link. */
  contact: string | undefined;
  /** Lets someone without an account sign up. */
  signup: string | undefined;
}

/**
 * Reads a pasted link. A link made by the app has both parts, joined by "~"; a bare token is
 * taken to be a sign-up token (an operator's seed Invite).
 */
export function parseInvite(text: string): InviteParts | undefined {
  const tail = (text.trim().split('/join/').at(-1) ?? '').trim();
  const [first, second, ...extra] = tail.split('~');
  if (extra.length > 0 || first === undefined || !TOKEN.test(first)) return undefined;
  if (second === undefined) return { contact: undefined, signup: first };
  return TOKEN.test(second) ? { contact: first, signup: second } : undefined;
}

export class AppController {
  private snapshot: Snapshot = {
    phase: 'starting',
    recoveryKey: undefined,
    connection: 'idle',
    conversations: [],
    revision: 0,
  };
  private session: Session | undefined;
  private pendingVault: Vault | undefined;
  private vault: Vault | undefined;
  private pendingContact: string | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: ControllerDeps) {}

  getSnapshot = (): Snapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(change: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...change, revision: this.snapshot.revision + 1 };
    this.listeners.forEach((listener) => listener());
  }

  /** Decides the first screen: sign up on a new Device, unlock on a known one. */
  async start(): Promise<void> {
    const known = (await this.deps.store.get('meta')) !== undefined;
    this.update({ phase: known ? 'locked' : 'sign-up' });
  }

  private vaultDeps() {
    return { sodium: this.deps.sodium, store: this.deps.store, ...kdfOf(this.deps) };
  }

  private accountDeps(vault: Vault): AccountDeps {
    const { sodium, random, bridge, network } = this.deps;
    return { sodium, random, bridge, network, vault };
  }

  /** Creates the vault and the Account. The Recovery Key is shown until the person confirms. */
  async signUp(input: SignUpInput): Promise<void> {
    const invite = parseInvite(input.inviteLink);
    if (invite?.signup === undefined) throw new ControllerError('bad_invite_link');
    const vault = await createVault(this.vaultDeps(), input.passcode);
    try {
      const result = await createAccount(this.accountDeps(vault), {
        ...input,
        inviteToken: invite.signup,
      });
      this.pendingVault = vault;
      this.pendingContact = invite.contact;
      this.update({ phase: 'recovery-key', recoveryKey: result.recoveryKey });
    } catch (error) {
      await vault.wipe();
      throw error;
    }
  }

  /**
   * The person has written the Recovery Key down: forget it and open the app. If they signed up
   * from an Invite link, the conversation with its creator is started and its id returned.
   */
  async confirmRecoveryKey(): Promise<string | undefined> {
    const vault = this.pendingVault;
    if (vault === undefined) throw new ControllerError('not_ready');
    const contact = this.pendingContact;
    this.pendingVault = this.pendingContact = undefined;
    this.update({ recoveryKey: undefined });
    await this.open(vault);
    return contact === undefined ? undefined : this.joinToken(contact);
  }

  async unlock(passcode: string): Promise<void> {
    await this.open(await unlockVault(this.vaultDeps(), passcode));
  }

  private async open(vault: Vault): Promise<void> {
    const account = await loadAccount(this.accountDeps(vault));
    if (account === undefined) throw new AccountError('failed');
    this.vault = vault;
    this.session = this.startSession(vault, account);
    this.update({ phase: 'ready' });
    await this.refresh();
  }

  private startSession(vault: Vault, account: Account): Session {
    const { sodium, random, clock, bridge, network, sockets, wsUrl } = this.deps;
    const deps: SessionDeps = { sodium, random, clock, bridge, network, sockets, wsUrl };
    const session = new Session(deps, vault, account, {
      changed: () => void this.refresh(),
      connection: (connection) =>
        this.update({ connection, ...(connection === 'unlinked' ? { phase: 'unlinked' } : {}) }),
    });
    session.start();
    return session;
  }

  private ready(): Session {
    if (this.session === undefined) throw new ControllerError('not_ready');
    return this.session;
  }

  /** Reloads the conversation list for the screens. */
  async refresh(): Promise<void> {
    const session = this.session;
    if (session === undefined) return;
    const records = await session.conversations.list();
    const conversations = await Promise.all(records.map((r) => this.summarise(session, r)));
    this.update({ conversations });
  }

  private async summarise(session: Session, record: ConversationRecord) {
    const { conversation } = await session.messenger.view(record.id);
    const lastId = conversation.order.at(-1);
    return { id: record.id, lastText: lastId && conversation.messages.get(lastId)?.text };
  }

  /**
   * A link to share. It carries two single-use tokens: one to sign up (for someone new) and one to
   * start a conversation with this person. Browsers never send the fragment to the server.
   */
  async createInviteLink(): Promise<string> {
    const { api } = this.ready();
    const expires = Math.floor(this.deps.clock.nowMs() / 1000) + INVITE_LIFETIME_S;
    const contact = await api.createInvite('contact', expires, 1);
    const signup = await api.createInvite('service', expires, 1);
    return `${this.deps.origin}/#/join/${contact.inviteToken}~${signup.inviteToken}`;
  }

  /** Starts a conversation from a pasted Invite link. Returns the conversation id. */
  async join(link: string): Promise<string> {
    const contact = parseInvite(link)?.contact;
    if (contact === undefined) throw new ControllerError('bad_invite_link');
    return this.joinToken(contact);
  }

  private async joinToken(token: string): Promise<string> {
    const record = await this.ready().conversations.start(token);
    await this.refresh();
    return record.id;
  }

  view(conversation: string): Promise<ViewState> {
    return this.ready().messenger.view(conversation);
  }

  /** Sends a message, or a reply, reaction or edit to one. */
  async send(conversation: string, content: Writable): Promise<void> {
    await this.ready().messenger.send(conversation, content);
    await this.refresh();
  }

  /** The network came back (or the page became visible): reconnect without waiting. */
  networkRestored(): void {
    this.session?.socket.retryNow();
  }

  /** Locks the app: the vault key is dropped and the connection closed. */
  lock(): void {
    this.session?.stop();
    this.session = undefined;
    this.vault?.lock();
    this.vault = undefined;
    this.update({ phase: 'locked', conversations: [], connection: 'idle' });
  }
}

function kdfOf(deps: ControllerDeps): { kdf?: KdfParams } {
  return deps.kdf === undefined ? {} : { kdf: deps.kdf };
}
