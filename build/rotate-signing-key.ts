// Manages the list of release-signing public keys in build/signing-keys.json (public data, kept in
// the repository and reviewed like code). The private keys stay in the HSM.
//
//   node build/rotate-signing-key.ts add <id> <public-key-base64url>   start trusting a key
//   node build/rotate-signing-key.ts revoke <id>                       stop trusting a key for good
//   node build/rotate-signing-key.ts trusted                           print "id:key,id2:key2"
//   node build/rotate-signing-key.ts revoked                           print "id,id2"
//
// The build pins these lists into the app and repeats them in every signed manifest. A revoked id
// can never be added back, and the last trusted key cannot be revoked (releases would be locked).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SigningKeys {
  trusted: Record<string, string>;
  revoked: string[];
}

export const KEY_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "signing-keys.json",
);
const ID = /^[a-z0-9-]{1,32}$/;

function isRawKey(text: string): boolean {
  return (
    /^[A-Za-z0-9_-]{43}$/.test(text) &&
    Buffer.from(text, "base64url").length === 32
  );
}

export function addKey(
  keys: SigningKeys,
  id: string,
  publicKey: string,
): SigningKeys {
  if (!ID.test(id))
    throw new Error('key id must be 1-32 characters of a-z, 0-9 and "-"');
  if (!isRawKey(publicKey))
    throw new Error("public key must be 32 bytes in base64url");
  if (keys.revoked.includes(id))
    throw new Error(`${id} was revoked and cannot be added again`);
  if (Object.hasOwn(keys.trusted, id))
    throw new Error(`${id} is already trusted`);
  if (Object.values(keys.trusted).includes(publicKey))
    throw new Error("that public key is already trusted");
  return {
    trusted: { ...keys.trusted, [id]: publicKey },
    revoked: keys.revoked,
  };
}

export function revokeKey(keys: SigningKeys, id: string): SigningKeys {
  if (!Object.hasOwn(keys.trusted, id))
    throw new Error(`${id} is not a trusted key`);
  const { [id]: _removed, ...rest } = keys.trusted;
  if (Object.keys(rest).length === 0)
    throw new Error("add a replacement key before revoking the last one");
  return { trusted: rest, revoked: [...keys.revoked, id] };
}

export const trustedList = (keys: SigningKeys): string =>
  Object.entries(keys.trusted)
    .map(([id, key]) => `${id}:${key}`)
    .join(",");

export const revokedList = (keys: SigningKeys): string =>
  keys.revoked.join(",");

/** The key file; tests point `SIGNING_KEYS_FILE` at a copy so they never touch the real one. */
const keyFile = (): string => process.env.SIGNING_KEYS_FILE ?? KEY_FILE;

function load(): SigningKeys {
  return JSON.parse(readFileSync(keyFile(), "utf8")) as SigningKeys;
}

function save(keys: SigningKeys): void {
  writeFileSync(keyFile(), `${JSON.stringify(keys, null, 2)}\n`);
}

function main(args: string[]): void {
  const [command, id, key] = args;
  if (command === "add" && id !== undefined && key !== undefined)
    save(addKey(load(), id, key));
  else if (command === "revoke" && id !== undefined)
    save(revokeKey(load(), id));
  else if (command === "trusted") process.stdout.write(trustedList(load()));
  else if (command === "revoked") process.stdout.write(revokedList(load()));
  else
    throw new Error(
      "usage: rotate-signing-key.ts add <id> <key> | revoke <id> | trusted | revoked",
    );
}

if (process.argv[1]?.endsWith("rotate-signing-key.ts"))
  main(process.argv.slice(2));
