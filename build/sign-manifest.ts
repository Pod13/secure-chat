// Release manifest tooling. Signing keys live in an HSM and never touch a developer machine or
// CI runner, so this tool never signs. It works in two steps:
//
//   node build/sign-manifest.ts unsigned <dist> <version> <minClientVersion> <keyId>
//       writes <dist>/manifest.unsigned.txt: the exact bytes the HSM must sign.
//   node build/sign-manifest.ts attach <dist> <signature-file> <public-key-file>
//       checks the HSM's signature against the public key, then writes <dist>/manifest.json.
//
// The manifest format is defined and checked in web/src/sw/manifest.ts; the end-to-end test in
// web/tests/build.test.ts proves the two agree.

import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const UNSIGNED = "manifest.unsigned.txt";
export const SIGNED = "manifest.json";

export interface Meta {
  version: string;
  minClientVersion: string;
  keyId: string;
  /** Public keys trusted from this release on, by key id (base64url). */
  trustedKeys: Record<string, string>;
  /** Key ids revoked for good; every release repeats all earlier ones. */
  revokedKeys: string[];
}

/** Files in a release directory, as sorted "/"-separated paths, without the manifest files. */
export function listFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else found.push(relative(dir, full).split(sep).join("/"));
    }
  };
  walk(dir);
  return found.filter((path) => path !== UNSIGNED && path !== SIGNED).sort();
}

const base64Url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");

/** JSON with sorted keys and no whitespace; must match `canonicalJson` in web/src/sw/manifest.ts. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record).sort();
    return `{${fields.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The manifest text to be signed: every file in `dir` with its SHA-256. */
export function manifestText(dir: string, meta: Meta): string {
  const files: Record<string, string> = {};
  for (const path of listFiles(dir)) {
    files[path] = base64Url(
      createHash("sha256")
        .update(readFileSync(join(dir, path)))
        .digest(),
    );
  }
  return canonicalJson({ v: 1, ...meta, files });
}

export function writeUnsigned(dir: string, meta: Meta): string {
  const text = manifestText(dir, meta);
  writeFileSync(join(dir, UNSIGNED), text);
  return text;
}

/** Raw 32-byte Ed25519 public key to a Node key object. */
function ed25519Public(raw: Uint8Array) {
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  return createPublicKey({
    key: Buffer.concat([prefix, raw]),
    format: "der",
    type: "spki",
  });
}

/** Writes manifest.json after checking the signature is valid for the unsigned text. */
export function attachSignature(
  dir: string,
  signature: Uint8Array,
  publicKey: Uint8Array,
): void {
  const text = readFileSync(join(dir, UNSIGNED), "utf8");
  const valid =
    signature.length === 64 &&
    publicKey.length === 32 &&
    verify(null, Buffer.from(text), ed25519Public(publicKey), signature);
  if (!valid)
    throw new Error("signature does not match the manifest and public key");
  writeFileSync(
    join(dir, SIGNED),
    JSON.stringify({ manifest: text, signature: base64Url(signature) }),
  );
}

function main(args: string[]): void {
  const [command, dir, ...rest] = args;
  if (command === "unsigned" && dir !== undefined && rest.length === 3) {
    const [version, minClientVersion, keyId] = rest as [string, string, string];
    const trustedKeys = Object.fromEntries(
      (process.env.RELEASE_PUBLIC_KEYS ?? "")
        .split(",")
        .filter(Boolean)
        .map((entry) => entry.split(":") as [string, string]),
    );
    const revokedKeys = (process.env.RELEASE_REVOKED_KEYS ?? "")
      .split(",")
      .filter(Boolean);
    writeUnsigned(dir, {
      version,
      minClientVersion,
      keyId,
      trustedKeys,
      revokedKeys,
    });
  } else if (command === "attach" && dir !== undefined && rest.length === 2) {
    const [signatureFile, keyFile] = rest as [string, string];
    const decode = (file: string) =>
      Buffer.from(readFileSync(file, "utf8").trim(), "base64url");
    attachSignature(dir, decode(signatureFile), decode(keyFile));
  } else {
    throw new Error("usage: sign-manifest.ts unsigned|attach <dist> ...");
  }
}

if (process.argv[1]?.endsWith("sign-manifest.ts")) main(process.argv.slice(2));
