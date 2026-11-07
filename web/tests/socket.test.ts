import { describe, expect, test } from 'vitest';

import type { ServerFrame } from '../src/net/frames';
import {
  MAX_BACKOFF_MS,
  MIN_BACKOFF_MS,
  PING_MS,
  RealtimeClient,
  backoffMs,
  type ConnectionState,
  type SocketConfig,
  type SocketLike,
  type SocketPorts,
} from '../src/net/socket';
import type { Random } from '../src/ports';

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(text: string): void {
    this.sent.push(text);
  }
  close(): void {
    this.closed = true;
  }
}

/** Timers that run only when the test says so. */
class Timers {
  pending: { ms: number; fn: () => void; live: boolean }[] = [];
  after = (ms: number, fn: () => void): (() => void) => {
    const entry = { ms, fn, live: true };
    this.pending.push(entry);
    return () => {
      entry.live = false;
    };
  };
  live(): { ms: number; fn: () => void; live: boolean }[] {
    return this.pending.filter((p) => p.live);
  }
  fireNext(): number {
    const next = this.live()[0];
    if (next === undefined) throw new Error('no timer pending');
    next.live = false;
    next.fn();
    return next.ms;
  }
}

const fixedRandom = (byte: number): Random => ({ bytes: (n) => new Uint8Array(n).fill(byte) });
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function setup(token: SocketConfig['token'] = () => Promise.resolve('tok')) {
  const sockets: FakeSocket[] = [];
  const timers = new Timers();
  const frames: ServerFrame[] = [];
  const states: ConnectionState[] = [];
  const ports: SocketPorts = {
    open: (url: string, protocols: string[]) => {
      const socket = new FakeSocket(url, protocols);
      sockets.push(socket);
      return socket;
    },
    after: timers.after,
    random: fixedRandom(0),
  };
  const client = new RealtimeClient(
    ports,
    { url: 'wss://example.test/v1/ws', token },
    {
      onFrame: (f: ServerFrame) => frames.push(f),
      onState: (s: ConnectionState) => states.push(s),
    },
  );
  const last = (): FakeSocket => sockets[sockets.length - 1] as FakeSocket;
  return { client, sockets, timers, frames, states, last };
}

const ENVELOPE = JSON.stringify({
  type: 'envelope',
  envelope_id: 'AAAAAAAAAAAAAAAAAAAAAA',
  ciphertext: 'AQID',
  enqueued_at: 1,
});

describe('backoff', () => {
  test('doubles from one second, caps at a minute, and is jittered between half and full', () => {
    const at = (attempt: number, byte: number) => backoffMs(attempt, fixedRandom(byte));
    expect(MIN_BACKOFF_MS).toBe(1000);
    expect(MAX_BACKOFF_MS).toBe(60_000);
    expect([0, 1, 2, 3].map((a) => at(a, 0))).toEqual([500, 1000, 2000, 4000]);
    expect([0, 1, 2, 3].map((a) => at(a, 255))).toEqual([998, 1996, 3992, 7984]);
    expect(at(6, 0)).toBe(30_000);
    expect(at(7, 0)).toBe(30_000);
    expect(at(50, 0)).toBe(30_000);
    expect(at(50, 255)).toBeLessThan(60_000);
    expect(at(50, 255)).toBeGreaterThan(59_000);
  });
});

describe('connecting', () => {
  test('sends the token in the subprotocol, never in the URL', async () => {
    const t = setup();
    t.client.start();
    await flush();
    expect(t.last().url).toBe('wss://example.test/v1/ws');
    expect(t.last().protocols).toEqual(['chat.v1', 'auth.tok']);
    expect(t.states).toEqual(['connecting']);
    t.last().onopen?.();
    expect(t.client.connection).toBe('open');
  });

  test('starting twice opens one socket', async () => {
    const t = setup();
    t.client.start();
    t.client.start();
    await flush();
    expect(t.sockets.length).toBe(1);
  });
});

describe('connecting, token problems', () => {
  test('a failing token fetch waits and tries again', async () => {
    let calls = 0;
    const t = setup(() =>
      ++calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve('tok'),
    );
    t.client.start();
    await flush();
    expect(t.client.connection).toBe('waiting');
    expect(t.sockets.length).toBe(0);
    t.timers.fireNext();
    await flush();
    expect(t.sockets.length).toBe(1);
  });

  test('stopping while the token is being fetched opens nothing', async () => {
    let release: (token: string) => void = () => undefined;
    const t = setup(() => new Promise((resolve) => (release = resolve)));
    t.client.start();
    t.client.stop();
    release('tok');
    await flush();
    expect(t.sockets.length).toBe(0);
    expect(t.client.connection).toBe('idle');
  });

  test('a failing token fetch after stop does not schedule a retry', async () => {
    let fail: (e: Error) => void = () => undefined;
    const t = setup(() => new Promise((_, reject) => (fail = reject)));
    t.client.start();
    t.client.stop();
    fail(new Error('x'));
    await flush();
    expect(t.timers.live().length).toBe(0);
    expect(t.client.connection).toBe('idle');
  });
});

describe('stale connections', () => {
  test('a token that arrives after stop and start does not open a second socket', async () => {
    const resolvers: ((token: string) => void)[] = [];
    const t = setup(() => new Promise((resolve) => resolvers.push(resolve)));
    t.client.start();
    t.client.stop();
    t.client.start();
    resolvers.forEach((release) => release('tok'));
    await flush();
    expect(t.sockets.length).toBe(1);
  });
});

describe('receiving', () => {
  test('valid frames reach the app', async () => {
    const t = setup();
    t.client.start();
    await flush();
    t.last().onopen?.();
    t.last().onmessage?.({ data: ENVELOPE });
    t.last().onmessage?.({ data: '{"type":"queue-empty"}' });
    expect(t.frames.map((f) => f.type)).toEqual(['envelope', 'queue-empty']);
  });

  test('an invalid or binary frame closes the connection and reconnects', async () => {
    for (const data of [
      'garbage',
      new ArrayBuffer(4),
      { toString: () => '{"type":"queue-empty"}' },
      '{"type":"ack","envelope_ids":[]}',
    ]) {
      const t = setup();
      t.client.start();
      await flush();
      t.last().onopen?.();
      const socket = t.last();
      socket.onmessage?.({ data });
      expect(socket.closed).toBe(true);
      expect(t.frames).toEqual([]);
      expect(t.client.connection).toBe('waiting');
    }
  });

  test('device-unlinked stops reconnecting for good', async () => {
    const t = setup();
    t.client.start();
    await flush();
    t.last().onopen?.();
    const socket = t.last();
    socket.onmessage?.({ data: '{"type":"device-unlinked","reason":"unlinked"}' });
    expect(t.frames).toEqual([{ type: 'device-unlinked', reason: 'unlinked' }]);
    expect(t.client.connection).toBe('unlinked');
    expect(socket.closed).toBe(true);
    expect(t.timers.live().length).toBe(0);
    t.client.start();
    await flush();
    expect(t.sockets.length).toBe(1);
  });
});

describe('reconnecting', () => {
  test('waits with growing delays and resets after a successful connection', async () => {
    const t = setup();
    t.client.start();
    await flush();
    const delays: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      t.last().onclose?.();
      delays.push(t.timers.fireNext());
      await flush();
    }
    expect(delays).toEqual([500, 1000, 2000]);
    t.last().onopen?.();
    t.timers.live().forEach((p) => (p.live = false));
    t.last().onerror?.();
    expect(t.timers.fireNext()).toBe(500);
  });

  test('a close from an old socket is ignored', async () => {
    const t = setup();
    t.client.start();
    await flush();
    const old = t.last();
    old.onclose?.();
    t.timers.fireNext();
    await flush();
    old.onclose?.();
    old.onmessage?.({ data: ENVELOPE });
    old.onopen?.();
    expect(t.sockets.length).toBe(2);
    expect(t.frames).toEqual([]);
    expect(t.timers.live().length).toBe(0);
  });

  test('stop cancels the pending reconnect', async () => {
    const t = setup();
    t.client.start();
    await flush();
    t.last().onclose?.();
    t.client.stop();
    expect(t.timers.live().length).toBe(0);
    expect(t.client.connection).toBe('idle');
  });
});

describe('sending', () => {
  test('pings every 30 seconds while open and stops after a close', async () => {
    const t = setup();
    t.client.start();
    await flush();
    t.last().onopen?.();
    expect(t.timers.fireNext()).toBe(PING_MS);
    expect(t.timers.fireNext()).toBe(PING_MS);
    expect(t.last().sent).toEqual(['{"type":"ping"}', '{"type":"ping"}']);
    t.last().onclose?.();
    expect(t.timers.live().map((p) => p.ms)).not.toContain(PING_MS);
  });

  test('a ping timer from an old connection does nothing', async () => {
    const t = setup();
    t.client.start();
    await flush();
    t.last().onopen?.();
    const stale = t.timers.live()[0] as { fn: () => void };
    t.client.stop();
    const socket = t.last();
    stale.fn();
    expect(socket.sent).toEqual([]);
    expect(t.timers.live().length).toBe(0);
  });

  test('acks go out only while open, in groups of at most 100', async () => {
    const t = setup();
    const ids = Array.from({ length: 250 }, () => new Uint8Array(16));
    expect(t.client.ack(ids)).toBe(false);
    t.client.start();
    await flush();
    expect(t.client.ack(ids)).toBe(false);
    t.last().onopen?.();
    expect(t.client.ack(ids)).toBe(true);
    const counts = t
      .last()
      .sent.map((s) => (JSON.parse(s) as { envelope_ids: string[] }).envelope_ids.length);
    expect(counts).toEqual([100, 100, 50]);
    expect(t.client.ack([])).toBe(true);
    expect(t.last().sent.length).toBe(3);
    t.last().sent.length = 0;
    t.client.ack(Array.from({ length: 100 }, () => new Uint8Array(16)));
    expect(t.last().sent.length).toBe(1);
  });
});

describe('reconnecting at once', () => {
  test('when the network returns, a waiting client connects now and starts its delays over', async () => {
    const t = setup();
    t.client.start();
    await flush();
    for (let i = 0; i < 4; i += 1) {
      t.last().onclose?.();
      t.timers.fireNext();
      await flush();
    }
    t.last().onclose?.();
    expect(t.client.connection).toBe('waiting');
    const before = t.sockets.length;
    t.client.retryNow();
    await flush();
    expect(t.sockets.length).toBe(before + 1);
    expect(t.timers.live()).toHaveLength(0); // the long wait was cancelled
    t.last().onclose?.();
    expect(t.timers.fireNext()).toBe(500); // delays began again from the start
  });

  test('does nothing unless the client is waiting to reconnect', async () => {
    const t = setup();
    t.client.retryNow(); // idle
    expect(t.sockets).toHaveLength(0);
    t.client.start();
    await flush();
    t.client.retryNow(); // connecting
    await flush();
    expect(t.sockets).toHaveLength(1);
    t.last().onopen?.();
    t.client.retryNow(); // open
    expect(t.sockets).toHaveLength(1);
  });

  test('a removed device never reconnects', async () => {
    const t = setup();
    t.client.start();
    await flush();
    t.last().onopen?.();
    t.last().onmessage?.({ data: JSON.stringify({ type: 'device-unlinked', reason: 'unlinked' }) });
    t.client.retryNow();
    await flush();
    expect(t.sockets).toHaveLength(1);
  });
});
