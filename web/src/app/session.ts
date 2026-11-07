// Everything that exists once the vault is open: the API client, conversations, messenger and the
// real-time connection. The socket delivers envelopes in order; each is stored (and its effects
// saved) before the server is told it can forget it, so a crash never loses a message.

import { Conversations } from '../crypto/conversation';
import type { Account } from '../crypto/account';
import type { MlsBridge } from '../crypto/bridge';
import type { Sodium } from '../crypto/sodium';
import { Api } from '../net/api';
import { Messenger } from '../net/delivery';
import { Outbox } from '../net/outbox';
import { RealtimeClient, type ConnectionState, type SocketPorts } from '../net/socket';
import type { ServerFrame } from '../net/frames';
import type { Clock, Network, Random } from '../ports';
import { History } from '../store/history';
import type { Vault } from '../store/vault';

export interface SessionDeps {
  sodium: Sodium;
  random: Random;
  clock: Clock;
  bridge: MlsBridge;
  network: Network;
  sockets: SocketPorts;
  wsUrl: string;
}

export interface SessionEvents {
  /** Something changed that a screen may want to show. */
  changed(): void;
  connection(state: ConnectionState): void;
}

export class Session {
  readonly api: Api;
  readonly conversations: Conversations;
  readonly messenger: Messenger;
  readonly socket: RealtimeClient;
  private frames: Promise<unknown> = Promise.resolve();

  constructor(
    deps: SessionDeps,
    vault: Vault,
    readonly account: Account,
    private readonly events: SessionEvents,
  ) {
    this.api = new Api({
      network: deps.network,
      clock: deps.clock,
      sodium: deps.sodium,
      deviceId: account.deviceId,
      secretKey: account.deviceSecretKey,
    });
    this.conversations = new Conversations({
      api: this.api,
      bridge: deps.bridge,
      device: account.device,
      vault,
      random: deps.random,
      clock: deps.clock,
    });
    this.messenger = new Messenger({
      conversations: this.conversations,
      outbox: new Outbox(vault, deps.random),
      api: this.api,
      history: new History(vault),
      device: account.device,
      random: deps.random,
      clock: deps.clock,
    });
    this.socket = new RealtimeClient(
      deps.sockets,
      { url: deps.wsUrl, token: () => this.api.token() },
      { onFrame: (frame) => this.enqueue(frame), onState: (state) => events.connection(state) },
    );
  }

  start(): void {
    this.socket.start();
  }

  stop(): void {
    this.socket.stop();
  }

  /** Frames are handled one at a time, in the order they arrived. */
  private enqueue(frame: ServerFrame): void {
    this.frames = this.frames.then(() => this.handle(frame)).catch(() => undefined);
  }

  private async handle(frame: ServerFrame): Promise<void> {
    if (frame.type === 'queue-empty') {
      await this.messenger.flush();
      await this.messenger.sweepExpired();
    } else if (frame.type === 'envelope') {
      const incoming = await this.conversations.handle(frame.ciphertext);
      await this.messenger.receive(incoming);
      this.socket.ack([frame.id]);
    }
    this.events.changed();
  }
}
