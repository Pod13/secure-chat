// Starting and joining 1:1 Conversations (FR-003, FR-006) and routing what arrives. The person who
// redeems an Invite creates the encryption group, adds the creator's Devices and sends each a
// Welcome through sealed-sender delivery. Their first message inside the group carries the
// delivery tokens that let the other side reply, so the server never sees who talks to whom.

import type { Clock, Random } from '../ports';
import { fromBase64Url, toBase64Url } from '../net/base64';
import type { RedeemedDevice } from '../net/api';
import type { Vault } from '../store/vault';
import { BridgeError, type Device, type MlsBridge } from './bridge';
import { MAX_ENDPOINTS, decodeMessage, encodeMessage, type Wire } from './messagetypes';

const INDEX = 'conv:index';
const RECORD = 'conv:';
const STATE = 'mls-state';

export type ConversationErrorCode = 'no_devices';

export class ConversationError extends Error {
  constructor(readonly code: ConversationErrorCode) {
    super(code);
    this.name = 'ConversationError';
  }
}

/** The relay calls conversations need (a subset of `Api`). */
export interface ConversationApi {
  redeemInvite(token: string): Promise<RedeemedDevice[]>;
  deliver(token: string, ciphertext: Uint8Array): Promise<void>;
  mintDeliveryToken(): Promise<{ token: string; tokenId: string }>;
}

export interface ConversationDeps {
  api: ConversationApi;
  bridge: MlsBridge;
  device: Device;
  vault: Vault;
  random: Random;
  clock: Clock;
}

export interface ConversationRecord {
  /** Lowercase hex of the group id. */
  id: string;
  groupId: Uint8Array;
  /** Delivery tokens, one per Device of the other person. */
  peerTokens: string[];
  /** Tokens this Device minted for the other person to reach it. */
  ownTokens: string[];
  ownTokenIds: string[];
}

export type Incoming =
  | { kind: 'joined'; conversation: string }
  | { kind: 'endpoints'; conversation: string }
  | { kind: 'message'; conversation: string; wire: Wire }
  | { kind: 'changed'; conversation: string }
  | { kind: 'removed'; conversation: string }
  | { kind: 'ignored' };

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

function serialize(record: ConversationRecord): Uint8Array {
  return encode({ ...record, groupId: toBase64Url(record.groupId) });
}

function deserialize(bytes: Uint8Array): ConversationRecord {
  const stored = JSON.parse(new TextDecoder().decode(bytes)) as ConversationRecord & {
    groupId: string;
  };
  return { ...stored, groupId: fromBase64Url(stored.groupId) as Uint8Array };
}

export class Conversations {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ConversationDeps) {}

  /** Runs `job` after every earlier job has finished, so saves never interleave. */
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job);
    this.tail = run.catch(() => undefined);
    return run;
  }

  async list(): Promise<ConversationRecord[]> {
    const ids = await this.ids();
    const records = await Promise.all(ids.map((id) => this.get(id)));
    return records.filter((record): record is ConversationRecord => record !== undefined);
  }

  async get(id: string): Promise<ConversationRecord | undefined> {
    const stored = await this.deps.vault.get(RECORD + id);
    return stored === undefined ? undefined : deserialize(stored);
  }

  private async ids(): Promise<string[]> {
    const stored = await this.deps.vault.get(INDEX);
    return stored === undefined ? [] : (JSON.parse(new TextDecoder().decode(stored)) as string[]);
  }

  private async save(record: ConversationRecord): Promise<void> {
    const ids = await this.ids();
    if (!ids.includes(record.id)) {
      await this.deps.vault.put(INDEX, encode([...ids, record.id]));
    }
    await this.deps.vault.put(RECORD + record.id, serialize(record));
    await this.saveState();
  }

  /** Keeps the Device's encryption state; call after anything that changes it. */
  saveState(): Promise<void> {
    return this.deps.vault.put(STATE, this.deps.device.exportState());
  }

  /** Redeems an Invite and starts a Conversation with the person who made it. */
  start(inviteToken: string): Promise<ConversationRecord> {
    return this.serial(async () => {
      const { api, device } = this.deps;
      const peers = await api.redeemInvite(inviteToken);
      if (peers.length === 0) throw new ConversationError('no_devices');
      const groupId = device.createGroup();
      await this.addPeers(groupId, peers);
      const own = await api.mintDeliveryToken();
      const record: ConversationRecord = {
        id: hex(groupId),
        groupId,
        peerTokens: peers.map((peer) => peer.deliveryToken),
        ownTokens: [own.token],
        ownTokenIds: [own.tokenId],
      };
      await this.sendEndpoints(record);
      await this.save(record);
      return record;
    });
  }

  /** Adds each Device: it gets a Welcome, and Devices added earlier get the commit. */
  private async addPeers(groupId: Uint8Array, peers: RedeemedDevice[]): Promise<void> {
    const { api, device } = this.deps;
    for (const [index, peer] of peers.entries()) {
      const keyPackage = peer.keyPackages[0] as Uint8Array;
      const added = device.addMember(groupId, keyPackage);
      await api.deliver(peer.deliveryToken, added.welcome);
      for (const earlier of peers.slice(0, index))
        await api.deliver(earlier.deliveryToken, added.commit);
    }
  }

  private async sendEndpoints(record: ConversationRecord): Promise<void> {
    const { device, api, random, clock } = this.deps;
    const id = hex(random.bytes(16));
    const content = { kind: 'endpoints' as const, tokens: record.ownTokens };
    const wire = encodeMessage({ v: 1, id, at: clock.nowMs(), content });
    const sealed = device.encrypt(record.groupId, wire);
    for (const token of record.peerTokens) await api.deliver(token, sealed);
  }

  /** Applies one envelope from the relay. Anything unusable is ignored, never thrown. */
  handle(envelope: Uint8Array): Promise<Incoming> {
    return this.serial(async () => {
      try {
        return await this.apply(envelope);
      } catch (error) {
        if (error instanceof BridgeError) return { kind: 'ignored' };
        throw error;
      }
    });
  }

  private async apply(envelope: Uint8Array): Promise<Incoming> {
    const { bridge, device } = this.deps;
    const route = bridge.route(envelope);
    if (route.kind === 'welcome') {
      const groupId = device.join(envelope);
      const record = { id: hex(groupId), groupId, peerTokens: [], ownTokens: [], ownTokenIds: [] };
      await this.save(record);
      return { kind: 'joined', conversation: record.id };
    }
    const conversation = hex(route.group);
    const received = device.receive(route.group, envelope);
    const incoming = await this.interpret(conversation, received);
    await this.saveState();
    return incoming;
  }

  private async interpret(
    conversation: string,
    received: ReturnType<Device['receive']>,
  ): Promise<Incoming> {
    if (received.kind === 'group-changed') return { kind: 'changed', conversation };
    if (received.kind === 'removed') return { kind: 'removed', conversation };
    const wire = decodeMessage(received.text);
    if (wire === undefined) return { kind: 'ignored' };
    if (wire.content.kind !== 'endpoints') return { kind: 'message', conversation, wire };
    const record = await this.get(conversation);
    if (record === undefined) return { kind: 'ignored' };
    const peerTokens = [...new Set([...record.peerTokens, ...wire.content.tokens])];
    await this.save({ ...record, peerTokens: peerTokens.slice(0, MAX_ENDPOINTS) });
    return { kind: 'endpoints', conversation };
  }
}
