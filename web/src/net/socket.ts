// The real-time channel client: one WebSocket per Device, reconnecting with growing, jittered
// delays. The session token goes in the subprotocol header, never in the URL (contract). The
// socket, timers and randomness are injected so tests drive every case without a network.

import type { Random } from '../ports';
import { MAX_ACK_IDS, PING_FRAME, ackFrame, parseServerFrame, type ServerFrame } from './frames';

export const PING_MS = 30_000;
export const MIN_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 60_000;

export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(text: string): void;
  close(): void;
}

export interface SocketPorts {
  open(url: string, protocols: string[]): SocketLike;
  /** Runs `fn` after `ms`; returns a function that cancels it. */
  after(ms: number, fn: () => void): () => void;
  random: Random;
}

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'waiting' | 'unlinked';

export interface SocketHandlers {
  onFrame(frame: ServerFrame): void;
  onState(state: ConnectionState): void;
}

export interface SocketConfig {
  url: string;
  /** Returns a fresh session token; may fail, in which case the client retries later. */
  token(): Promise<string>;
}

/** Delay before reconnect attempt number `attempt` (0 first): doubling, capped, then jittered. */
export function backoffMs(attempt: number, random: Random): number {
  const base = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.min(attempt, 10));
  const jitter = random.bytes(1).reduce((sum, byte) => sum + byte, 0) / 256;
  return Math.floor(base / 2 + (base / 2) * jitter);
}

export class RealtimeClient {
  private socket: SocketLike | undefined;
  /** The socket, once it has opened; the only one acks may be sent on. */
  private live: SocketLike | undefined;
  private generation = 0;
  private attempt = 0;
  private cancelTimer: (() => void) | undefined;
  private state: ConnectionState = 'idle';

  constructor(
    private readonly ports: SocketPorts,
    private readonly config: SocketConfig,
    private readonly handlers: SocketHandlers,
  ) {}

  get connection(): ConnectionState {
    return this.state;
  }

  start(): void {
    if (this.state !== 'idle') return;
    void this.connect();
  }

  /** Disconnects and stays disconnected until `start` is called again. */
  stop(): void {
    this.teardown();
    this.setState('idle');
  }

  /** Tells the server these envelopes are stored. Returns false when not connected. */
  ack(ids: Uint8Array[]): boolean {
    const socket = this.live;
    if (socket === undefined) return false;
    for (let i = 0; i < ids.length; i += MAX_ACK_IDS) {
      socket.send(ackFrame(ids.slice(i, i + MAX_ACK_IDS)));
    }
    return true;
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.handlers.onState(state);
  }

  /** Drops the socket and timers; callbacks from the old socket are ignored from now on. */
  private teardown(): void {
    this.generation += 1;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    const socket = this.socket;
    this.socket = this.live = undefined;
    if (socket !== undefined) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
    }
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    this.setState('connecting');
    let token: string;
    try {
      token = await this.config.token();
    } catch {
      if (generation === this.generation) this.retryLater();
      return;
    }
    if (generation !== this.generation) return;
    const socket = this.ports.open(this.config.url, ['chat.v1', `auth.${token}`]);
    this.socket = socket;
    socket.onopen = () => this.opened(generation, socket);
    socket.onmessage = (event) => this.received(event.data);
    socket.onclose = () => this.closed();
    socket.onerror = () => this.closed();
  }

  private opened(generation: number, socket: SocketLike): void {
    this.attempt = 0;
    this.live = socket;
    this.setState('open');
    this.schedulePing(generation, socket);
  }

  private schedulePing(generation: number, socket: SocketLike): void {
    this.cancelTimer = this.ports.after(PING_MS, () => {
      if (generation !== this.generation) return;
      socket.send(PING_FRAME);
      this.schedulePing(generation, socket);
    });
  }

  private received(data: unknown): void {
    const frame = typeof data === 'string' ? parseServerFrame(data) : undefined;
    if (frame === undefined) {
      this.closed();
      return;
    }
    if (frame.type === 'device-unlinked') {
      this.teardown();
      this.setState('unlinked');
    }
    this.handlers.onFrame(frame);
  }

  private closed(): void {
    this.teardown();
    this.retryLater();
  }

  private retryLater(): void {
    this.setState('waiting');
    const delay = backoffMs(this.attempt, this.ports.random);
    this.attempt += 1;
    this.cancelTimer = this.ports.after(delay, () => void this.connect());
  }
}
