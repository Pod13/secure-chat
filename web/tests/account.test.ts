import { beforeAll, describe, expect, test } from 'vitest';

import {
  AccountError,
  KEY_PACKAGES_AT_SIGNUP,
  createAccount,
  loadAccount,
  type AccountDeps,
} from '../src/crypto/account';
import type { Device, MlsBridge } from '../src/crypto/bridge';
import { fromBase64Url } from '../src/net/base64';
import { deriveRecoverySecrets, parseRecoveryKey } from '../src/crypto/recoverykeys';
import { MIN_KDF, createSodium, type Sodium } from '../src/crypto/sodium';
import { webRandom } from '../src/ports';
import { createVault } from '../src/store/vault';
import { FakeNetwork, MemoryStore } from './fakes';

const INVITE = 'A'.repeat(43);
const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const created = {
  status: 201,
  body: json({ account_id: 'a'.repeat(22), device_id: 'd'.repeat(22) }),
};

let sodium: Sodium;
beforeAll(async () => {
  sodium = await createSodium(webRandom);
});

/** A device that records what it was asked and hands out numbered key packages. */
function fakeBridge() {
  let counter = 0;
  const made: Uint8Array[] = [];
  const closed: string[] = [];
  const device = {
    keyPackage: () => Uint8Array.of(1, ++counter),
    lastResortKeyPackage: () => Uint8Array.of(2),
    exportState: () => Uint8Array.of(3, 3, 3),
    close: () => void closed.push('device'),
  } as unknown as Device;
  const bridge: MlsBridge = {
    newDevice: (identity) => {
      made.push(identity);
      return device;
    },
    restoreDevice: (state) => {
      made.push(state);
      return device;
    },
  };
  return { bridge, made, device, closed };
}

async function setup(responses = [created]) {
  const network = new FakeNetwork(responses);
  const vault = await createVault(
    { sodium, store: new MemoryStore(), kdf: MIN_KDF },
    'correct horse battery',
  );
  const { bridge, made, device, closed } = fakeBridge();
  const deps: AccountDeps = { sodium, random: webRandom, bridge, network, vault };
  return { deps, network, vault, made, device, closed };
}

const input = { inviteToken: INVITE, username: 'alice', deviceName: 'Alice phone' };

describe('creating an account', () => {
  test('sends only public keys and sealed data, and the certificate verifies', async () => {
    const { deps, network, made } = await setup();
    const result = await createAccount(deps, input);
    const request = network.requests[0];
    expect(request).toMatchObject({ method: 'POST', path: '/v1/accounts' });
    const body = JSON.parse(new TextDecoder().decode(request?.body)) as Record<
      string,
      string | string[]
    >;
    expect(Object.keys(body).sort()).toEqual([
      'device_certificate',
      'device_public_key',
      'identity_public_key',
      'invite_token',
      'key_packages',
      'label_blob',
      'last_resort_key_package',
    ]);
    expect(body.invite_token).toBe(INVITE);
    expect((body.key_packages as string[]).length).toBe(KEY_PACKAGES_AT_SIGNUP);
    const identity = fromBase64Url(body.identity_public_key as string) as Uint8Array;
    const devicePublic = fromBase64Url(body.device_public_key as string) as Uint8Array;
    const certificate = fromBase64Url(body.device_certificate as string) as Uint8Array;
    const signed = Uint8Array.from([
      ...new TextEncoder().encode('secure-chat/device-certificate/v1'),
      ...devicePublic,
    ]);
    expect(sodium.verifyDetached(certificate, signed, identity)).toBe(true);
    expect(made[0]).toEqual(devicePublic);
    expect(result.accountId).toBe('a'.repeat(22));
    expect(result.deviceId).toBe('d'.repeat(22));
  });
});

describe('what the server learns', () => {
  test('never sends the username, the passcode, the Recovery Key or a private key', async () => {
    const { deps, network } = await setup();
    const result = await createAccount(deps, input);
    const sent = new TextDecoder().decode(network.requests[0]?.body);
    expect(sent).not.toContain('alice');
    expect(sent).not.toContain('Alice phone');
    expect(sent).not.toContain('correct horse');
    expect(sent).not.toContain(result.recoveryKey.replaceAll('-', ''));
    const parsed = parseRecoveryKey(result.recoveryKey, sodium);
    const secrets = await deriveRecoverySecrets(parsed, sodium);
    const base = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
    expect(sent).not.toContain(base(secrets.accessToken));
    expect(sent).not.toContain(base(secrets.backupKey));
    expect(sent).toContain(base(secrets.identity.publicKey));
  });

  test('derives the identity key from the Recovery Key shown to the person', async () => {
    const { deps, network } = await setup();
    const result = await createAccount(deps, input);
    const secrets = await deriveRecoverySecrets(
      parseRecoveryKey(result.recoveryKey, sodium),
      sodium,
    );
    const body = JSON.parse(new TextDecoder().decode(network.requests[0]?.body)) as Record<
      string,
      string
    >;
    expect(fromBase64Url(body.identity_public_key as string)).toEqual(secrets.identity.publicKey);
  });
});

describe('what is kept on the Device', () => {
  test('keeps the Device state and details only in the sealed vault', async () => {
    const { deps, vault } = await setup();
    await createAccount(deps, input);
    const loaded = await loadAccount(deps);
    expect(loaded).toMatchObject({
      accountId: 'a'.repeat(22),
      deviceId: 'd'.repeat(22),
      username: 'alice',
    });
    expect(await vault.get('mls-state')).toEqual(Uint8Array.of(3, 3, 3));
  });

  test('does not keep the identity private key or the Recovery Key', async () => {
    const { deps, vault } = await setup();
    const result = await createAccount(deps, input);
    const secrets = await deriveRecoverySecrets(
      parseRecoveryKey(result.recoveryKey, sodium),
      sodium,
    );
    const record = new TextDecoder().decode(await vault.get('account'));
    expect(record).not.toContain(Buffer.from(secrets.identity.secretKey).toString('base64url'));
    expect(record).not.toContain(result.recoveryKey);
  });
});

describe('when sign-up fails', () => {
  test.each([
    [401, 'invite_invalid'],
    [429, 'rate_limited'],
    [400, 'failed'],
    [500, 'failed'],
  ])('a %i response is reported as %s and nothing is stored', async (status, code) => {
    const { deps, vault } = await setup([{ status, body: json({ error: 'x' }) }]);
    await expect(createAccount(deps, input)).rejects.toMatchObject({ code });
    expect(await vault.get('account')).toBeUndefined();
    expect(await vault.get('mls-state')).toBeUndefined();
  });

  test('a response that does not look like an account is refused', async () => {
    const { deps } = await setup([{ status: 201, body: json({ account_id: 1 }) }]);
    await expect(createAccount(deps, input)).rejects.toMatchObject({ code: 'bad_response' });
    const second = await setup([{ status: 201, body: new TextEncoder().encode('not json') }]);
    await expect(createAccount(second.deps, input)).rejects.toThrow(AccountError);
  });

  test('a malformed invite token is refused before anything is sent', async () => {
    const { deps, network } = await setup();
    await expect(createAccount(deps, { ...input, inviteToken: 'short' })).rejects.toMatchObject({
      code: 'invite_invalid',
    });
    expect(network.requests).toHaveLength(0);
  });

  test('an empty username is refused', async () => {
    const { deps, network } = await setup();
    await expect(createAccount(deps, { ...input, username: '  ' })).rejects.toMatchObject({
      code: 'username_required',
    });
    expect(network.requests).toHaveLength(0);
  });
});

describe('loading the account', () => {
  test('names the Device when the person gives no name', async () => {
    const { deps } = await setup();
    await createAccount(deps, { inviteToken: INVITE, username: 'alice' });
    expect((await loadAccount(deps))?.deviceName).toBe('This device');
  });

  test('reports nothing when no account exists', async () => {
    const { deps } = await setup();
    expect(await loadAccount(deps)).toBeUndefined();
  });
});

describe('details the server must not read', () => {
  test('seals the Device name with a key that stays on the Device', async () => {
    const { deps, network } = await setup();
    await createAccount(deps, input);
    const body = JSON.parse(new TextDecoder().decode(network.requests[0]?.body)) as Record<
      string,
      string
    >;
    const account = await loadAccount(deps);
    const label = fromBase64Url(body.label_blob as string) as Uint8Array;
    const name = sodium.open(account?.labelKey as Uint8Array, label);
    expect(new TextDecoder().decode(name)).toBe('Alice phone');
    expect(Buffer.from(label).toString('utf8')).not.toContain('Alice phone');
  });

  test('uses the default name when none is given', async () => {
    const { deps, network } = await setup();
    await createAccount(deps, { inviteToken: INVITE, username: 'alice' });
    const body = JSON.parse(new TextDecoder().decode(network.requests[0]?.body)) as Record<
      string,
      string
    >;
    const account = await loadAccount(deps);
    const label = fromBase64Url(body.label_blob as string) as Uint8Array;
    expect(new TextDecoder().decode(sodium.open(account?.labelKey as Uint8Array, label))).toBe(
      'This device',
    );
  });

  test('publishes distinct, non-empty key packages and a different last-resort package', async () => {
    const { deps, network } = await setup();
    await createAccount(deps, input);
    const body = JSON.parse(new TextDecoder().decode(network.requests[0]?.body)) as {
      key_packages: string[];
      last_resort_key_package: string;
    };
    expect(new Set(body.key_packages).size).toBe(KEY_PACKAGES_AT_SIGNUP);
    expect(body.key_packages.every((kp) => kp.length > 0)).toBe(true);
    expect(body.key_packages).not.toContain(body.last_resort_key_package);
  });
});

describe('strictness', () => {
  test.each([
    ['account_id only', { account_id: 'a'.repeat(22) }],
    ['device_id only', { device_id: 'd'.repeat(22) }],
    ['numbers', { account_id: 1, device_id: 2 }],
    ['a number for the device', { account_id: 'a'.repeat(22), device_id: 2 }],
  ])('refuses a response with %s', async (_name, reply) => {
    const { deps, vault } = await setup([{ status: 201, body: json(reply) }]);
    await expect(createAccount(deps, input)).rejects.toMatchObject({ code: 'bad_response' });
    expect(await vault.get('account')).toBeUndefined();
  });

  test.each(['!' + 'A'.repeat(43), 'A'.repeat(44), 'A'.repeat(42) + '!', '!' + 'A'.repeat(42)])(
    'refuses the invite token %s',
    async (token) => {
      const { deps, network } = await setup();
      await expect(createAccount(deps, { ...input, inviteToken: token })).rejects.toMatchObject({
        code: 'invite_invalid',
      });
      expect(network.requests).toHaveLength(0);
    },
  );

  test('releases the Device when the server says no', async () => {
    const { deps, closed } = await setup([{ status: 401, body: json({}) }]);
    await expect(createAccount(deps, input)).rejects.toThrow();
    expect(closed).toEqual(['device']);
  });

  test('loads nothing when either record is missing', async () => {
    const { deps, vault } = await setup();
    await createAccount(deps, input);
    await vault.delete('mls-state');
    expect(await loadAccount(deps)).toBeUndefined();
    const second = await setup();
    await createAccount(second.deps, input);
    await second.vault.delete('account');
    expect(await loadAccount(second.deps)).toBeUndefined();
  });

  test('gives back the same keys that were made', async () => {
    const { deps, network } = await setup();
    await createAccount(deps, input);
    const body = JSON.parse(new TextDecoder().decode(network.requests[0]?.body)) as Record<
      string,
      string
    >;
    const account = await loadAccount(deps);
    expect(account?.devicePublicKey).toEqual(fromBase64Url(body.device_public_key as string));
    expect(account?.deviceSecretKey).toHaveLength(64);
    expect(account?.labelKey).toHaveLength(32);
    expect(new AccountError('failed').name).toBe('AccountError');
  });
});
