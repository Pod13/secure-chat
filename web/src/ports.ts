// Injected I/O (Constitution XIII). Security-critical code never touches the clock, the random
// number generator, storage or the network directly; it is handed these ports so tests can
// control them.

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  nowMs(): number;
}

export interface Random {
  /** Cryptographically secure random bytes. */
  bytes(length: number): Uint8Array;
}

export interface KeyValueStore {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: Uint8Array;
}

export interface HttpResponse {
  status: number;
  body: Uint8Array;
}

export interface Network {
  request(request: HttpRequest): Promise<HttpResponse>;
}

export const systemClock: Clock = { nowMs: () => Date.now() };

export const webRandom: Random = {
  bytes(length) {
    const out = new Uint8Array(length);
    crypto.getRandomValues(out);
    return out;
  },
};
