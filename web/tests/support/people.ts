// Shared test setup for conversation tests: a relay that keeps queues in memory, and people with
// real MLS devices and encrypted vaults.

import type { Device } from '../../src/crypto/bridge';
import { Conversations, type ConversationApi } from '../../src/crypto/conversation';
import { MIN_KDF, createSodium, type Sodium } from '../../src/crypto/sodium';
import { webRandom } from '../../src/ports';
import { createVault } from '../../src/store/vault';
import { FakeClock, MemoryStore } from '../fakes';
import { realBridge } from './realMls';

export const bridge = realBridge();
export const tokenFor = (n: number): string => String.fromCharCode(97 + n).repeat(43);

/** An in-memory stand-in for the relay: delivery queues per token, and redeemable invites. */
export class FakeRelay {
  readonly queues = new Map<string, Uint8Array[]>();
  invites = new Map<string, { deliveryToken: string; keyPackages: Uint8Array[] }[]>();
  /** Tokens for which delivery fails, to simulate an outage. */
  down = new Set<string>();
  /** The next this-many deliveries fail, then the relay recovers. */
  failNext = 0;
  private minted = 100;

  api(): ConversationApi {
    return {
      redeemInvite: (token) => {
        const devices = this.invites.get(token);
        return devices === undefined
          ? Promise.reject(new Error('no invite'))
          : Promise.resolve(devices);
      },
      deliver: (token, ciphertext) => {
        const failing = this.down.has(token) || this.consumeFailure();
        if (failing) return Promise.reject(new Error('relay unreachable'));
        this.queues.set(token, [...(this.queues.get(token) ?? []), ciphertext]);
        return Promise.resolve();
      },
      mintDeliveryToken: () => {
        const n = this.minted++;
        return Promise.resolve({ token: tokenFor(n % 26), tokenId: `id${n}`.padEnd(22, 'x') });
      },
    };
  }

  private consumeFailure(): boolean {
    if (this.failNext <= 0) return false;
    this.failNext -= 1;
    return true;
  }

  take(token: string): Uint8Array[] {
    const items = this.queues.get(token) ?? [];
    this.queues.delete(token);
    return items;
  }
}

let sodiumPromise: Promise<Sodium> | undefined;
export const sodiumForTests = (): Promise<Sodium> => (sodiumPromise ??= createSodium(webRandom));

export async function person(relay: FakeRelay, name: string, store = new MemoryStore()) {
  const sodium = await sodiumForTests();
  const device: Device = bridge.newDevice(new TextEncoder().encode(name));
  const vault = await createVault({ sodium, store, kdf: MIN_KDF }, 'correct horse battery');
  const clock = new FakeClock(1_700_000_000_000);
  const conversations = new Conversations({
    api: relay.api(),
    bridge,
    device,
    vault,
    random: webRandom,
    clock,
  });
  return { device, vault, clock, conversations, relay };
}

export type Person = Awaited<ReturnType<typeof person>>;

/** Bob redeems Alice's invite; Alice processes what arrived. Returns both with the conversation. */
export async function pairUp() {
  const relay = new FakeRelay();
  const alice = await person(relay, 'alice');
  const bob = await person(relay, 'bob');
  relay.invites.set('INVITE', [
    {
      deliveryToken: tokenFor(0),
      keyPackages: [alice.device.keyPackage(), alice.device.lastResortKeyPackage()],
    },
  ]);
  const started = await bob.conversations.start('INVITE');
  const received = [];
  for (const envelope of relay.take(tokenFor(0))) {
    received.push(await alice.conversations.handle(envelope));
  }
  return { relay, alice, bob, started, received };
}
