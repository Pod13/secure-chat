import { describe, expect, test } from 'vitest';

import { AppController, ControllerError, parseInvite } from '../src/app/controller';
import { toBase64Url } from '../src/net/base64';
import type { SocketLike, SocketPorts } from '../src/net/socket';
import { MIN_KDF } from '../src/crypto/sodium';
import { webRandom } from '../src/ports';
import { FakeClock, MemoryStore } from './fakes';
import { bridge, sodiumForTests } from './support/people';
import { ScriptedNetwork, bodyJson, json } from './support/scripted';

const INVITE = 'A'.repeat(43);
const ID = (n: number): string => toBase64Url(new Uint8Array(16).fill(n));
const PASSCODE = 'correct horse battery';

class InertSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  closed = false;
  send(text: string): void {
    this.sent.push(text);
  }
  close(): void {
    this.closed = true;
  }
}

async function make(store = new MemoryStore(), network = new ScriptedNetwork()) {
  const sockets: InertSocket[] = [];
  const ports: SocketPorts = {
    open: () => {
      const socket = new InertSocket();
      sockets.push(socket);
      return socket;
    },
    after: () => () => undefined,
    random: webRandom,
  };
  if (!network.routes.has('POST /v1/accounts')) {
    network.on('POST /v1/accounts', () => json({ account_id: ID(1), device_id: ID(2) }, 201));
  }
  const clock = new FakeClock(1_700_000_000_000);
  const controller = new AppController({
    store,
    sodium: await sodiumForTests(),
    random: webRandom,
    clock,
    bridge,
    network,
    sockets: ports,
    origin: 'https://chat.example',
    wsUrl: 'wss://chat.example/v1/ws',
    kdf: MIN_KDF,
  });
  await controller.start();
  return { controller, store, network, sockets, clock };
}

const signUp = { inviteLink: INVITE, username: 'alice', passcode: PASSCODE };
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe('first screen', () => {
  test('a new Device starts at sign-up; a known Device asks for the passcode', async () => {
    const first = await make();
    expect(first.controller.getSnapshot().phase).toBe('sign-up');
    await first.controller.signUp(signUp);
    await first.controller.confirmRecoveryKey();
    const again = await make(first.store);
    expect(again.controller.getSnapshot().phase).toBe('locked');
  });
});

describe('signing up', () => {
  test('shows the Recovery Key once, then forgets it and opens the app', async () => {
    const { controller, sockets } = await make();
    await controller.signUp(signUp);
    const shown = controller.getSnapshot();
    expect(shown.phase).toBe('recovery-key');
    expect(shown.recoveryKey).toMatch(/^([A-Z2-7]{5}-){10}[A-Z2-7]{5}$/);
    await controller.confirmRecoveryKey();
    const ready = controller.getSnapshot();
    expect(ready.phase).toBe('ready');
    expect(ready.recoveryKey).toBeUndefined();
    await flush();
    expect(sockets).toHaveLength(1);
    await expect(controller.confirmRecoveryKey()).rejects.toBeInstanceOf(ControllerError);
  });

  test('a refused Invite leaves nothing behind and allows another try', async () => {
    const network = new ScriptedNetwork().on('POST /v1/accounts', () => json({}, 401));
    const { controller, store } = await make(new MemoryStore(), network);
    await expect(controller.signUp(signUp)).rejects.toMatchObject({ code: 'invite_invalid' });
    expect(await store.keys()).toEqual([]);
    expect(controller.getSnapshot().phase).toBe('sign-up');
    network.on('POST /v1/accounts', () => json({ account_id: ID(1), device_id: ID(2) }, 201));
    await controller.signUp(signUp);
    expect(controller.getSnapshot().phase).toBe('recovery-key');
  });
});

describe('unlocking', () => {
  test('a wrong passcode is refused and the right one opens the app', async () => {
    const first = await make();
    await first.controller.signUp(signUp);
    await first.controller.confirmRecoveryKey();
    const again = await make(first.store);
    await expect(again.controller.unlock('wrong passcode here')).rejects.toMatchObject({
      code: 'wrong_passcode',
    });
    expect(again.controller.getSnapshot().phase).toBe('locked');
    await again.controller.unlock(PASSCODE);
    expect(again.controller.getSnapshot().phase).toBe('ready');
  });

  test('locking closes the connection and returns to the passcode screen', async () => {
    const { controller, sockets } = await make();
    await controller.signUp(signUp);
    await controller.confirmRecoveryKey();
    await flush();
    controller.lock();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'locked', conversations: [] });
    expect(sockets[0]?.closed).toBe(true);
    await expect(controller.createInviteLink()).rejects.toBeInstanceOf(ControllerError);
  });
});

describe('invites', () => {
  test('the link carries a contact token and a sign-up token in the fragment', async () => {
    const { controller, network } = await make();
    await controller.signUp(signUp);
    await controller.confirmRecoveryKey();
    let n = 0;
    network.on('POST /v1/invites', () =>
      json({ invite_token: String.fromCharCode(75 + n).repeat(43), invite_id: ID(++n) }, 201),
    );
    const link = await controller.createInviteLink();
    expect(link).toBe(`https://chat.example/#/join/${'K'.repeat(43)}~${'L'.repeat(43)}`);
    const [contact, service] = network.to('POST /v1/invites').map(bodyJson);
    expect(contact).toMatchObject({ kind: 'contact', max_uses: 1 });
    expect(service).toMatchObject({ kind: 'service', max_uses: 1 });
    expect(contact?.expires_at).toBe(1_700_000_000 + 7 * 24 * 60 * 60);
  });

  test.each([
    [`https://chat.example/#/join/${INVITE}`, { contact: undefined, signup: INVITE }],
    [`  ${INVITE}  `, { contact: undefined, signup: INVITE }],
    [`#/join/${INVITE}~${'B'.repeat(43)}`, { contact: INVITE, signup: 'B'.repeat(43) }],
    [`/join/${INVITE}~${'B'.repeat(43)}`, { contact: INVITE, signup: 'B'.repeat(43) }],
    ['https://chat.example/#/join/short', undefined],
    [`${INVITE}A`, undefined],
    [`${INVITE}~short`, undefined],
    [`${INVITE}~${INVITE}~${INVITE}`, undefined],
    ['short~' + INVITE, undefined],
    ['', undefined],
    ['not a link!', undefined],
  ])('reads %j', (text, expected) => {
    expect(parseInvite(text)).toEqual(expected);
  });

  test('signing up needs a sign-up token, so a contact-only paste is refused', async () => {
    const { controller, network } = await make();
    await expect(controller.signUp({ ...signUp, inviteLink: 'nonsense' })).rejects.toMatchObject({
      code: 'bad_invite_link',
    });
    expect(network.to('POST /v1/accounts')).toHaveLength(0);
  });

  test('joining with something that is not an Invite link is refused before any request', async () => {
    const { controller, network } = await make();
    await controller.signUp(signUp);
    await controller.confirmRecoveryKey();
    await expect(controller.join('nonsense')).rejects.toMatchObject({ code: 'bad_invite_link' });
    await expect(controller.join(INVITE)).rejects.toMatchObject({ code: 'bad_invite_link' });
    expect(network.to('POST /v1/invites/redeem')).toHaveLength(0);
  });
});

describe('the connection', () => {
  async function ready() {
    const made = await make();
    await made.controller.signUp(signUp);
    await made.controller.confirmRecoveryKey();
    await flush();
    const socket = made.sockets[0] as InertSocket;
    socket.onopen?.();
    return { ...made, socket };
  }

  test('acknowledges an envelope only after it has been dealt with', async () => {
    const { socket } = await ready();
    const id = new Uint8Array(16).fill(5);
    const frame = {
      type: 'envelope',
      envelope_id: toBase64Url(id),
      ciphertext: 'AQID',
      enqueued_at: 1,
    };
    socket.onmessage?.({ data: JSON.stringify(frame) });
    await flush();
    expect(socket.sent).toContainEqual(
      JSON.stringify({ type: 'ack', envelope_ids: [toBase64Url(id)] }),
    );
  });

  test('moves to the unlinked screen when this Device is removed', async () => {
    const { controller, socket } = await ready();
    socket.onmessage?.({ data: JSON.stringify({ type: 'device-unlinked', reason: 'unlinked' }) });
    await flush();
    expect(controller.getSnapshot().phase).toBe('unlinked');
  });
});

describe('the connection, continued', () => {
  async function ready() {
    const made = await make();
    await made.controller.signUp(signUp);
    await made.controller.confirmRecoveryKey();
    await flush();
    const socket = made.sockets[0] as InertSocket;
    socket.onopen?.();
    return { ...made, socket };
  }

  test('reconnects at once when the network returns', async () => {
    const { controller, socket, sockets } = await ready();
    controller.networkRestored(); // connected already: nothing to do
    expect(sockets).toHaveLength(1);
    socket.onclose?.();
    controller.networkRestored();
    await flush();
    expect(sockets).toHaveLength(2);
  });

  test('ignores a returning network before the app is open', async () => {
    const { controller } = await make();
    expect(() => controller.networkRestored()).not.toThrow();
  });

  test('catches up when the queue is empty', async () => {
    const { socket, controller } = await ready();
    let changes = 0;
    controller.subscribe(() => (changes += 1));
    socket.onmessage?.({ data: JSON.stringify({ type: 'queue-empty' }) });
    await flush();
    expect(changes).toBeGreaterThan(0);
  });
});

describe('joining from a link', () => {
  test('signing up with a full link lands in a conversation, and messages can be sent', async () => {
    const network = new ScriptedNetwork();
    const creator = bridge.newDevice(new TextEncoder().encode('creator'));
    network.on('POST /v1/invites/redeem', () =>
      json({
        devices: [
          { delivery_token: 'a'.repeat(43), key_packages: [toBase64Url(creator.keyPackage())] },
        ],
      }),
    );
    network.on('POST /v1/deliver', () => json({ envelope_id: ID(9) }, 201));
    network.on('POST /v1/delivery-tokens', () =>
      json({ token: 'z'.repeat(43), token_id: ID(8) }, 201),
    );
    const { controller } = await make(new MemoryStore(), network);
    await controller.signUp({ ...signUp, inviteLink: `#/join/${'C'.repeat(43)}~${INVITE}` });
    expect(bodyJson(network.to('POST /v1/accounts')[0] as never).invite_token).toBe(INVITE);
    const id = await controller.confirmRecoveryKey();
    expect(controller.getSnapshot().conversations.map((c) => c.id)).toEqual([id]);
    expect(network.to('POST /v1/deliver')).toHaveLength(2); // the Welcome and the first message
    expect(bodyJson(network.to('POST /v1/invites/redeem')[0] as never).invite_token).toBe(
      'C'.repeat(43),
    );
    await controller.send(id as string, { kind: 'text', text: 'hello there' });
    expect(network.to('POST /v1/deliver')).toHaveLength(3);
    expect(controller.getSnapshot().conversations[0]?.lastText).toBe('hello there');
    expect((await controller.view(id as string)).conversation.order).toHaveLength(1);
  });

  test('signing up with a bare token starts no conversation', async () => {
    const { controller } = await make();
    await controller.signUp(signUp);
    expect(await controller.confirmRecoveryKey()).toBeUndefined();
    expect(controller.getSnapshot().conversations).toEqual([]);
  });
});
