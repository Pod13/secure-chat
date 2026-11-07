// The encrypted outgoing queue. Messages wait here, inside the vault, until the server accepts
// them. Each has a client-generated id, so a retry after a dropped connection never creates a
// duplicate (FR-015). Calls are run one at a time so the index never loses an entry.

import type { Random } from '../ports';
import type { Vault } from '../store/vault';

export const MAX_PENDING = 1000;

const INDEX = 'outbox:index';
const ITEM = 'outbox:item:';
const ID_PATTERN = /^[0-9a-f]{32}$/;

export type OutboxErrorCode = 'bad_id' | 'full';

export class OutboxError extends Error {
  constructor(readonly code: OutboxErrorCode) {
    super(code);
    this.name = 'OutboxError';
  }
}

export interface PendingMessage {
  id: string;
  payload: Uint8Array;
}

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export class Outbox {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly vault: Vault,
    private readonly random: Random,
    private readonly limit: number = MAX_PENDING,
  ) {}

  /** Runs `job` after every earlier call has finished, whether it succeeded or failed. */
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async ids(): Promise<string[]> {
    const raw = await this.vault.get(INDEX);
    return raw === undefined ? [] : (JSON.parse(new TextDecoder().decode(raw)) as string[]);
  }

  private saveIds(ids: string[]): Promise<void> {
    return this.vault.put(INDEX, new TextEncoder().encode(JSON.stringify(ids)));
  }

  /** Queues a message. Using an id that is already queued changes nothing. Returns the id. */
  enqueue(payload: Uint8Array, id: string = hex(this.random.bytes(16))): Promise<string> {
    return this.serial(async () => {
      if (!ID_PATTERN.test(id)) throw new OutboxError('bad_id');
      const ids = await this.ids();
      if (ids.includes(id)) return id;
      if (ids.length >= this.limit) throw new OutboxError('full');
      await this.vault.put(ITEM + id, payload);
      await this.saveIds([...ids, id]);
      return id;
    });
  }

  /** Waiting messages, oldest first. */
  pending(): Promise<PendingMessage[]> {
    return this.serial(async () => {
      const found: PendingMessage[] = [];
      for (const id of await this.ids()) {
        const payload = await this.vault.get(ITEM + id);
        if (payload !== undefined) found.push({ id, payload });
      }
      return found;
    });
  }

  /** The server accepted this message: forget it. */
  markSent(id: string): Promise<void> {
    return this.serial(async () => {
      const ids = await this.ids();
      await this.saveIds(ids.filter((other) => other !== id));
      await this.vault.delete(ITEM + id);
    });
  }
}
