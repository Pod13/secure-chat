// The HTTP calls the app makes (contracts/http-api.md): Device login with a signed challenge, and
// the few calls conversations need. Anonymous calls (redeem, deliver) carry no session token, so
// the server cannot tie them to an Account. Replies from the server are checked for their exact
// shape before use.

import type { Sodium } from '../crypto/sodium';
import type { Clock, HttpResponse, Network } from '../ports';
import { fromBase64Url, toBase64Url } from './base64';

/** A session is renewed this long before it expires. */
export const SESSION_MARGIN_MS = 30_000;

const LOGIN_DOMAIN = 'secure-chat/login/v1';

export type ApiErrorCode = 'unauthorized' | 'rate_limited' | 'bad_response' | 'failed';

export class ApiError extends Error {
  constructor(readonly code: ApiErrorCode) {
    super(code);
    this.name = 'ApiError';
  }
}

export interface ApiDeps {
  network: Network;
  clock: Clock;
  sodium: Sodium;
  /** This Device's id (base64url) and signing key. */
  deviceId: string;
  secretKey: Uint8Array;
}

export interface RedeemedDevice {
  deliveryToken: string;
  keyPackages: Uint8Array[];
}

type Json = Record<string, unknown>;

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

function statusError(status: number): ApiError {
  if (status === 401) return new ApiError('unauthorized');
  return new ApiError(status === 429 ? 'rate_limited' : 'failed');
}

function parseObject(response: HttpResponse): Json {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(response.body));
    if (typeof value === 'object' && value !== null) return value as Json;
  } catch {
    // Falls through to the error below.
  }
  throw new ApiError('bad_response');
}

/** The reply's text field, which must be a non-empty string of base64url characters. */
function text(object: Json, name: string): string {
  const value = object[name];
  if (typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)) return value;
  throw new ApiError('bad_response');
}

function bytes(value: unknown): Uint8Array {
  const decoded = typeof value === 'string' ? fromBase64Url(value) : undefined;
  if (decoded === undefined) throw new ApiError('bad_response');
  return decoded;
}

function readDevices(reply: Json): RedeemedDevice[] {
  const devices = reply.devices;
  if (!Array.isArray(devices)) throw new ApiError('bad_response');
  return devices.map((entry: unknown) => {
    const device = (typeof entry === 'object' && entry !== null ? entry : {}) as Json;
    const packages = device.key_packages;
    if (!Array.isArray(packages)) throw new ApiError('bad_response');
    return { deliveryToken: text(device, 'delivery_token'), keyPackages: packages.map(bytes) };
  });
}

export class Api {
  private session: { token: string; expiresAt: number } | undefined;
  private login: Promise<string> | undefined;

  constructor(private readonly deps: ApiDeps) {}

  private async send(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body: unknown,
    token?: string,
  ): Promise<HttpResponse> {
    const response = await this.deps.network.request({
      method,
      path: `/v1${path}`,
      body: encode(body),
      ...(token === undefined ? {} : { token }),
    });
    const ok = response.status >= 200 && response.status < 300;
    if (!ok) {
      if (token !== undefined && response.status === 401) this.session = undefined;
      throw statusError(response.status);
    }
    return response;
  }

  /** A valid session token, logging in first when there is none or it is nearly expired. */
  token(): Promise<string> {
    const session = this.session;
    if (session !== undefined && this.deps.clock.nowMs() < session.expiresAt - SESSION_MARGIN_MS) {
      return Promise.resolve(session.token);
    }
    this.login ??= this.signIn().finally(() => {
      this.login = undefined;
    });
    return this.login;
  }

  private async signIn(): Promise<string> {
    const { deviceId, sodium, secretKey, clock } = this.deps;
    const challenge = parseObject(
      await this.send('POST', '/auth/challenge', { device_id: deviceId }),
    );
    const nonce = bytes(text(challenge, 'nonce'));
    const message = Uint8Array.from([
      ...new TextEncoder().encode(LOGIN_DOMAIN),
      ...bytes(deviceId),
      ...nonce,
    ]);
    const signature = toBase64Url(sodium.signDetached(secretKey, message));
    const reply = parseObject(
      await this.send('POST', '/auth/token', { device_id: deviceId, signature }),
    );
    const lifetime = reply.expires_in;
    if (typeof lifetime !== 'number') throw new ApiError('bad_response');
    const token = text(reply, 'token');
    this.session = { token, expiresAt: clock.nowMs() + lifetime * 1000 };
    return token;
  }

  private async authed(method: 'POST' | 'PUT', path: string, body: unknown): Promise<HttpResponse> {
    return this.send(method, path, body, await this.token());
  }

  async redeemInvite(inviteToken: string): Promise<RedeemedDevice[]> {
    const response = await this.send('POST', '/invites/redeem', { invite_token: inviteToken });
    return readDevices(parseObject(response));
  }

  /** Sealed-sender send: no session, so the server learns nothing about who is sending. */
  async deliver(token: string, ciphertext: Uint8Array): Promise<void> {
    await this.send('POST', '/deliver', { token, ciphertext: toBase64Url(ciphertext) });
  }

  async createInvite(kind: 'contact' | 'group' | 'service', expiresAt: number, maxUses: number) {
    const reply = parseObject(
      await this.authed('POST', '/invites', { kind, expires_at: expiresAt, max_uses: maxUses }),
    );
    return { inviteToken: text(reply, 'invite_token'), inviteId: text(reply, 'invite_id') };
  }

  async mintDeliveryToken(): Promise<{ token: string; tokenId: string }> {
    const reply = parseObject(await this.authed('POST', '/delivery-tokens', {}));
    return { token: text(reply, 'token'), tokenId: text(reply, 'token_id') };
  }

  async putKeyPackages(keyPackages: Uint8Array[]): Promise<void> {
    await this.authed('PUT', '/devices/me/key-packages', {
      key_packages: keyPackages.map(toBase64Url),
    });
  }
}
