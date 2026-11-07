import type {
  Clock,
  HttpRequest,
  HttpResponse,
  KeyValueStore,
  Network,
  Random,
} from '../src/ports';

/** A clock the test moves by hand. */
export class FakeClock implements Clock {
  constructor(private ms: number) {}

  nowMs(): number {
    return this.ms;
  }

  advance(ms: number): void {
    this.ms += ms;
  }
}

/** Predictable bytes (0, 1, 2, ...) for tests. Never use outside tests: it is not random. */
export class CountingRandom implements Random {
  private next = 0;

  bytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      out[i] = this.next % 256;
      this.next += 1;
    }
    return out;
  }
}

export class MemoryStore implements KeyValueStore {
  readonly entries = new Map<string, Uint8Array>();

  get(key: string): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.entries.get(key));
  }

  put(key: string, value: Uint8Array): Promise<void> {
    this.entries.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }

  keys(): Promise<string[]> {
    return Promise.resolve([...this.entries.keys()]);
  }
}

/** Answers requests from a queue and records what was asked. */
export class FakeNetwork implements Network {
  readonly requests: HttpRequest[] = [];

  constructor(private readonly responses: HttpResponse[]) {}

  request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const next = this.responses.shift();
    return next === undefined
      ? Promise.reject(new Error('FakeNetwork has no response queued'))
      : Promise.resolve(next);
  }
}
