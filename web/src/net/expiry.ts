// Undelivered messages are deleted by the server after a fixed retention period (FR-031). The
// server cannot tell the sender (it never learns who sent what), so the sender's own Device
// works it out: a message still not delivered by then has expired, and the person is told.

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface Tracked {
  state: string;
  /** When the message was first sent, in milliseconds. */
  at: number;
}

/** Ids of messages that are neither delivered nor already expired and have outlived retention. */
export function expiredIds(statuses: ReadonlyMap<string, Tracked>, nowMs: number): string[] {
  return [...statuses]
    .filter(
      ([, s]) => (s.state === 'sending' || s.state === 'sent') && nowMs - s.at >= RETENTION_MS,
    )
    .map(([id]) => id);
}
