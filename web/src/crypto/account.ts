// Account creation on a new Device (FR-001). Keys are made here and never leave the Device: the
// server receives public keys, key packages and a sealed Device name, and nothing it could use to
// learn the username, the passcode or the Recovery Key. Everything private is kept in the vault.

import type { Network, Random } from '../ports';
import { fromBase64Url, toBase64Url } from '../net/base64';
import type { Vault } from '../store/vault';
import type { Device, MlsBridge } from './bridge';
import {
  deriveRecoverySecrets,
  formatRecoveryKey,
  generateRecoveryKey,
  type RecoverySecrets,
} from './recoverykeys';
import type { Sodium } from './sodium';

/** Single-use key packages published at sign-up; more are added as they are used up. */
export const KEY_PACKAGES_AT_SIGNUP = 20;

const CERTIFICATE_DOMAIN = 'secure-chat/device-certificate/v1';
const ACCOUNT_RECORD = 'account';
const STATE_RECORD = 'mls-state';
const INVITE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_DEVICE_NAME = 'This device';

export type AccountErrorCode =
  'invite_invalid' | 'username_required' | 'rate_limited' | 'bad_response' | 'failed';

export class AccountError extends Error {
  constructor(readonly code: AccountErrorCode) {
    super(code);
    this.name = 'AccountError';
  }
}

export interface AccountDeps {
  sodium: Sodium;
  random: Random;
  bridge: MlsBridge;
  network: Network;
  vault: Vault;
}

export interface SignupInput {
  inviteToken: string;
  username: string;
  deviceName?: string;
}

export interface Account {
  accountId: string;
  deviceId: string;
  username: string;
  deviceName: string;
  /** The Device signing key used to log in to the server. */
  deviceSecretKey: Uint8Array;
  devicePublicKey: Uint8Array;
  /** Keyed-hash key for Device names and other labels (never sent to the server). */
  labelKey: Uint8Array;
  device: Device;
}

export interface SignupResult {
  accountId: string;
  deviceId: string;
  /** Shown once, never stored. */
  recoveryKey: string;
  device: Device;
}

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

interface Prepared {
  body: Record<string, unknown>;
  recoveryKey: string;
  device: Device;
  signing: { publicKey: Uint8Array; secretKey: Uint8Array };
  labelKey: Uint8Array;
}

function certificate(sodium: Sodium, secrets: RecoverySecrets, devicePublic: Uint8Array) {
  const message = Uint8Array.from([...encode(CERTIFICATE_DOMAIN), ...devicePublic]);
  return sodium.signDetached(secrets.identity.secretKey, message);
}

async function prepare(deps: AccountDeps, input: SignupInput): Promise<Prepared> {
  const { sodium, random } = deps;
  const recovery = generateRecoveryKey(random);
  const secrets = await deriveRecoverySecrets(recovery, sodium);
  const signing = sodium.signingKeyPair(random.bytes(32));
  const device = deps.bridge.newDevice(signing.publicKey);
  const labelKey = random.bytes(32);
  const label = sodium.seal(labelKey, encode(input.deviceName ?? DEFAULT_DEVICE_NAME));
  const body = {
    invite_token: input.inviteToken,
    identity_public_key: toBase64Url(secrets.identity.publicKey),
    device_public_key: toBase64Url(signing.publicKey),
    device_certificate: toBase64Url(certificate(sodium, secrets, signing.publicKey)),
    key_packages: Array.from({ length: KEY_PACKAGES_AT_SIGNUP }, () =>
      toBase64Url(device.keyPackage()),
    ),
    last_resort_key_package: toBase64Url(device.lastResortKeyPackage()),
    label_blob: toBase64Url(label),
  };
  return { body, recoveryKey: formatRecoveryKey(recovery, sodium), device, signing, labelKey };
}

function failure(status: number): AccountError {
  if (status === 401) return new AccountError('invite_invalid');
  return new AccountError(status === 429 ? 'rate_limited' : 'failed');
}

function readIds(bytes: Uint8Array): { accountId: string; deviceId: string } {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const { account_id: accountId, device_id: deviceId } = parsed;
    if (typeof accountId === 'string' && typeof deviceId === 'string') {
      return { accountId, deviceId };
    }
  } catch {
    // Falls through to the error below.
  }
  throw new AccountError('bad_response');
}

async function save(vault: Vault, account: Omit<Account, 'device'>, state: Uint8Array) {
  const record = {
    accountId: account.accountId,
    deviceId: account.deviceId,
    username: account.username,
    deviceName: account.deviceName,
    deviceSecretKey: toBase64Url(account.deviceSecretKey),
    devicePublicKey: toBase64Url(account.devicePublicKey),
    labelKey: toBase64Url(account.labelKey),
  };
  await vault.put(ACCOUNT_RECORD, encode(JSON.stringify(record)));
  await vault.put(STATE_RECORD, state);
}

/** Makes the keys, registers the Account and keeps the private parts in the vault. */
export async function createAccount(deps: AccountDeps, input: SignupInput): Promise<SignupResult> {
  const username = input.username.trim();
  if (username === '') throw new AccountError('username_required');
  if (!INVITE_PATTERN.test(input.inviteToken)) throw new AccountError('invite_invalid');
  const prepared = await prepare(deps, input);
  const response = await deps.network.request({
    method: 'POST',
    path: '/v1/accounts',
    body: encode(JSON.stringify(prepared.body)),
  });
  if (response.status !== 201) {
    prepared.device.close();
    throw failure(response.status);
  }
  const ids = readIds(response.body);
  const { signing, labelKey, device } = prepared;
  await save(
    deps.vault,
    {
      ...ids,
      username,
      deviceName: input.deviceName ?? DEFAULT_DEVICE_NAME,
      deviceSecretKey: signing.secretKey,
      devicePublicKey: signing.publicKey,
      labelKey,
    },
    device.exportState(),
  );
  return { ...ids, recoveryKey: prepared.recoveryKey, device };
}

/** Vault records are authenticated, so a stored key is always well-formed base64url. */
const bytesOf = (value: string | undefined): Uint8Array =>
  fromBase64Url(value as string) as Uint8Array;

/** Reads the Account back from the unlocked vault; `undefined` if this Device has none. */
export async function loadAccount(deps: AccountDeps): Promise<Account | undefined> {
  const stored = await deps.vault.get(ACCOUNT_RECORD);
  const state = await deps.vault.get(STATE_RECORD);
  if (stored === undefined || state === undefined) return undefined;
  const r = JSON.parse(new TextDecoder().decode(stored)) as Record<string, string>;
  return {
    accountId: r.accountId as string,
    deviceId: r.deviceId as string,
    username: r.username as string,
    deviceName: r.deviceName as string,
    deviceSecretKey: bytesOf(r.deviceSecretKey),
    devicePublicKey: bytesOf(r.devicePublicKey),
    labelKey: bytesOf(r.labelKey),
    device: deps.bridge.restoreDevice(state),
  };
}
