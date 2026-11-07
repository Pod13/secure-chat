import { beforeAll, describe, expect, test } from 'vitest';

import { Api, ApiError, SESSION_MARGIN_MS } from '../src/net/api';
import { fromBase64Url, toBase64Url } from '../src/net/base64';
import { createSodium, type Sodium } from '../src/crypto/sodium';
import type { HttpResponse } from '../src/ports';
import { webRandom } from '../src/ports';
import { FakeClock, FakeNetwork } from './fakes';

const DEVICE_BYTES = new Uint8Array(16).fill(7);
const DEVICE_ID = toBase64Url(DEVICE_BYTES);
const NONCE = new Uint8Array(32).fill(9);
const TOKEN = 'T'.repeat(43);
const json = (value: unknown, status = 200): HttpResponse => ({
  status,
  body: new TextEncoder().encode(JSON.stringify(value)),
});
const bodyOf = (request: { body?: Uint8Array } | undefined): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(request?.body)) as Record<string, unknown>;

const loginReplies = (expiresIn = 900): HttpResponse[] => [
  json({ nonce: toBase64Url(NONCE) }),
  json({ token: TOKEN, expires_in: expiresIn }),
];

let sodium: Sodium;
let keys: { publicKey: Uint8Array; secretKey: Uint8Array };
beforeAll(async () => {
  sodium = await createSodium(webRandom);
  keys = sodium.signingKeyPair(new Uint8Array(32).fill(3));
});

function make(replies: HttpResponse[]) {
  const network = new FakeNetwork(replies);
  const clock = new FakeClock(1_000_000);
  const api = new Api({ network, clock, sodium, deviceId: DEVICE_ID, secretKey: keys.secretKey });
  return { api, network, clock };
}

describe('logging in', () => {
  test('signs the server challenge with the Device key under the login label', async () => {
    const { api, network } = make([...loginReplies(), json({}, 204)]);
    await api.putKeyPackages([Uint8Array.of(1)]);
    expect(network.requests[0]).toMatchObject({ method: 'POST', path: '/v1/auth/challenge' });
    expect(bodyOf(network.requests[0])).toEqual({ device_id: DEVICE_ID });
    const signature = fromBase64Url(bodyOf(network.requests[1]).signature as string) as Uint8Array;
    const message = Uint8Array.from([
      ...new TextEncoder().encode('secure-chat/login/v1'),
      ...DEVICE_BYTES,
      ...NONCE,
    ]);
    expect(sodium.verifyDetached(signature, message, keys.publicKey)).toBe(true);
    expect(network.requests[2]?.token).toBe(TOKEN);
  });

  test('reuses the session until it is about to expire, then logs in again', async () => {
    const { api, network, clock } = make([
      ...loginReplies(60),
      json({}, 204),
      json({}, 204),
      ...loginReplies(60),
      json({}, 204),
    ]);
    await api.putKeyPackages([Uint8Array.of(1)]);
    clock.advance(60_000 - SESSION_MARGIN_MS - 1);
    await api.putKeyPackages([Uint8Array.of(1)]);
    expect(network.requests.filter((r) => r.path === '/v1/auth/challenge')).toHaveLength(1);
    clock.advance(2);
    await api.putKeyPackages([Uint8Array.of(1)]);
    expect(network.requests.filter((r) => r.path === '/v1/auth/challenge')).toHaveLength(2);
  });

  test('shares one login between calls made at the same time', async () => {
    const { api, network } = make([...loginReplies(), json({}, 204), json({}, 204)]);
    await Promise.all([
      api.putKeyPackages([Uint8Array.of(1)]),
      api.putKeyPackages([Uint8Array.of(2)]),
    ]);
    expect(network.requests.filter((r) => r.path === '/v1/auth/challenge')).toHaveLength(1);
  });
});

describe('login failures', () => {
  test.each([
    ['a refused challenge', [json({}, 401)], 'unauthorized'],
    ['a malformed challenge', [json({ nonce: 5 })], 'bad_response'],
    [
      'a refused token request',
      [json({ nonce: toBase64Url(NONCE) }), json({}, 401)],
      'unauthorized',
    ],
    [
      'a malformed token reply',
      [json({ nonce: toBase64Url(NONCE) }), json({ token: TOKEN })],
      'bad_response',
    ],
  ])('reports %s', async (_name, replies, code) => {
    const { api } = make(replies);
    await expect(api.token()).rejects.toMatchObject({ code });
  });

  test('tries again after a failed login', async () => {
    const { api } = make([json({}, 500), ...loginReplies()]);
    await expect(api.token()).rejects.toBeInstanceOf(ApiError);
    await expect(api.token()).resolves.toBe(TOKEN);
  });

  test('forgets the session when the server rejects the token', async () => {
    const { api, network } = make([
      ...loginReplies(),
      json({}, 401),
      ...loginReplies(),
      json({}, 204),
    ]);
    await expect(api.putKeyPackages([Uint8Array.of(1)])).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await api.putKeyPackages([Uint8Array.of(1)]);
    expect(network.requests.filter((r) => r.path === '/v1/auth/challenge')).toHaveLength(2);
  });
});

describe('calls that need no login', () => {
  test('redeems an invite and returns each Device with its token and key packages', async () => {
    const { api, network } = make([
      json({
        devices: [{ delivery_token: TOKEN, key_packages: [toBase64Url(Uint8Array.of(5, 6))] }],
      }),
    ]);
    const devices = await api.redeemInvite('I'.repeat(43));
    expect(devices).toEqual([{ deliveryToken: TOKEN, keyPackages: [Uint8Array.of(5, 6)] }]);
    expect(network.requests[0]).toMatchObject({ path: '/v1/invites/redeem' });
    expect(network.requests[0]?.token).toBeUndefined();
  });

  test('delivers an envelope with only the token and the ciphertext', async () => {
    const { api, network } = make([json({ envelope_id: 'x' }, 201)]);
    await api.deliver(TOKEN, Uint8Array.of(1, 2, 3));
    expect(bodyOf(network.requests[0])).toEqual({
      token: TOKEN,
      ciphertext: toBase64Url(Uint8Array.of(1, 2, 3)),
    });
    expect(network.requests[0]?.token).toBeUndefined();
  });

  test.each([
    [401, 'unauthorized'],
    [429, 'rate_limited'],
    [500, 'failed'],
    [400, 'failed'],
    [300, 'failed'],
    [199, 'failed'],
  ])('maps status %i to %s', async (status, code) => {
    const { api } = make([json({}, status)]);
    await expect(api.deliver(TOKEN, Uint8Array.of(1))).rejects.toMatchObject({ code });
  });
});

describe('redeem replies are checked', () => {
  test.each([
    ['not an object', { devices: 5 }],
    ['a device without a token', { devices: [{ key_packages: ['AQ'] }] }],
    ['a device without key packages', { devices: [{ delivery_token: TOKEN, key_packages: 'x' }] }],
    [
      'a key package that is not base64url',
      { devices: [{ delivery_token: TOKEN, key_packages: ['!'] }] },
    ],
  ])('refuses a redeem reply with %s', async (_name, reply) => {
    const { api } = make([json(reply)]);
    await expect(api.redeemInvite('I'.repeat(43))).rejects.toMatchObject({ code: 'bad_response' });
  });

  test.each(['null', '5', '"text"'])('refuses the reply %s', async (reply) => {
    const { api } = make([{ status: 200, body: new TextEncoder().encode(reply) }]);
    await expect(api.redeemInvite('I'.repeat(43))).rejects.toMatchObject({ code: 'bad_response' });
  });

  test('refuses a key package that is not text', async () => {
    const { api } = make([json({ devices: [{ delivery_token: TOKEN, key_packages: [5] }] })]);
    await expect(api.redeemInvite('I'.repeat(43))).rejects.toMatchObject({ code: 'bad_response' });
  });

  test('refuses a device entry that is not an object', async () => {
    const { api } = make([json({ devices: [null] })]);
    await expect(api.redeemInvite('I'.repeat(43))).rejects.toMatchObject({ code: 'bad_response' });
  });

  test('refuses a reply that is not JSON', async () => {
    const { api } = make([{ status: 200, body: new TextEncoder().encode('nope') }]);
    await expect(api.redeemInvite('I'.repeat(43))).rejects.toMatchObject({ code: 'bad_response' });
  });
});

describe('calls that need a login', () => {
  test('creates an Invite', async () => {
    const { api, network } = make([
      ...loginReplies(),
      json({ invite_token: 'K'.repeat(43), invite_id: 'i'.repeat(22) }, 201),
    ]);
    const invite = await api.createInvite('contact', 5000, 1);
    expect(invite).toEqual({ inviteToken: 'K'.repeat(43), inviteId: 'i'.repeat(22) });
    expect(bodyOf(network.requests[2])).toEqual({ kind: 'contact', expires_at: 5000, max_uses: 1 });
  });

  test('mints a delivery token', async () => {
    const { api } = make([
      ...loginReplies(),
      json({ token: TOKEN, token_id: 't'.repeat(22) }, 201),
    ]);
    expect(await api.mintDeliveryToken()).toEqual({ token: TOKEN, tokenId: 't'.repeat(22) });
  });

  test.each([
    ['invite', { invite_token: 5, invite_id: 'x' }],
    ['delivery token', { token: TOKEN }],
  ])('refuses a bad %s reply', async (which, reply) => {
    const { api } = make([...loginReplies(), json(reply, 201)]);
    const call = which === 'invite' ? api.createInvite('contact', 1, 1) : api.mintDeliveryToken();
    await expect(call).rejects.toMatchObject({ code: 'bad_response' });
  });

  test('uploads key packages as base64url', async () => {
    const { api, network } = make([...loginReplies(), json({}, 204)]);
    await api.putKeyPackages([Uint8Array.of(1), Uint8Array.of(2)]);
    expect(network.requests[2]).toMatchObject({
      method: 'PUT',
      path: '/v1/devices/me/key-packages',
    });
    expect(bodyOf(network.requests[2])).toEqual({ key_packages: ['AQ', 'Ag'] });
    expect(new ApiError('failed').name).toBe('ApiError');
  });
});

describe('every call goes to its documented method and path', () => {
  const REDEEM = json({ devices: [{ delivery_token: TOKEN, key_packages: ['AQ'] }] });
  const calls: [string, string, string, boolean, HttpResponse, (api: Api) => Promise<unknown>][] = [
    ['redeem', 'POST', '/v1/invites/redeem', false, REDEEM, (a) => a.redeemInvite('I'.repeat(43))],
    [
      'deliver',
      'POST',
      '/v1/deliver',
      false,
      json({}, 201),
      (a) => a.deliver(TOKEN, Uint8Array.of(1)),
    ],
    [
      'invite',
      'POST',
      '/v1/invites',
      true,
      json({ invite_token: TOKEN, invite_id: 'i'.repeat(22) }),
      (a) => a.createInvite('group', 1, 2),
    ],
    [
      'delivery token',
      'POST',
      '/v1/delivery-tokens',
      true,
      json({ token: TOKEN, token_id: 't'.repeat(22) }),
      (a) => a.mintDeliveryToken(),
    ],
    [
      'key packages',
      'PUT',
      '/v1/devices/me/key-packages',
      true,
      json({}, 204),
      (a) => a.putKeyPackages([]),
    ],
  ];

  test.each(calls)('%s', async (_name, method, path, needsLogin, reply, call) => {
    const { api, network } = make([...(needsLogin ? loginReplies() : []), reply]);
    await call(api);
    const last = network.requests.at(-1);
    expect(last).toMatchObject({ method, path });
    expect(last?.token === TOKEN).toBe(needsLogin);
    if (needsLogin) {
      expect(network.requests[1]).toMatchObject({ method: 'POST', path: '/v1/auth/token' });
    }
  });
});

describe('request bodies', () => {
  const REDEEM = json({ devices: [{ delivery_token: TOKEN, key_packages: ['AQ'] }] });

  test('redeem sends the invite token and nothing else', async () => {
    const { api, network } = make([REDEEM]);
    await api.redeemInvite('I'.repeat(43));
    expect(bodyOf(network.requests[0])).toEqual({ invite_token: 'I'.repeat(43) });
  });
});

describe('session handling at the edges', () => {
  test('logs in again exactly when the margin is reached', async () => {
    const { api, network, clock } = make([...loginReplies(60), ...loginReplies(60)]);
    await api.token();
    clock.advance(60_000 - SESSION_MARGIN_MS);
    await api.token();
    expect(network.requests.filter((r) => r.path === '/v1/auth/challenge')).toHaveLength(2);
  });

  test('keeps the session when an anonymous call or a server error fails', async () => {
    const { api, network } = make([...loginReplies(), json({}, 401), json({}, 500), json({}, 204)]);
    await api.token();
    await expect(api.deliver(TOKEN, Uint8Array.of(1))).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(api.putKeyPackages([])).rejects.toMatchObject({ code: 'failed' });
    await api.putKeyPackages([]);
    expect(network.requests.filter((r) => r.path === '/v1/auth/challenge')).toHaveLength(1);
  });

  test('anonymous requests have no token field at all', async () => {
    const { api, network } = make([json({}, 201)]);
    await api.deliver(TOKEN, Uint8Array.of(1));
    expect('token' in (network.requests[0] as object)).toBe(false);
  });
});

test.each(['!bad', 'bad!', 'ba d', ''])(
  'refuses a delivery token reply containing %j',
  async (bad) => {
    const { api } = make([json({ devices: [{ delivery_token: bad, key_packages: [] }] })]);
    await expect(api.redeemInvite('I'.repeat(43))).rejects.toMatchObject({ code: 'bad_response' });
  },
);
