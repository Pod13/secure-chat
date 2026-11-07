// Unpadded base64url, the encoding used for every binary field on the wire.

const ALPHABET = /^[A-Za-z0-9_-]*$/;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Strict decode: right alphabet, no padding, and only the canonical spelling of the bytes. */
export function fromBase64Url(text: string): Uint8Array | undefined {
  if (!ALPHABET.test(text) || text.length % 4 === 1) return undefined;
  // Browsers' `atob` accepts the unpadded form, so no padding is added back.
  const standard = text.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(standard), (c) => c.charCodeAt(0));
  return toBase64Url(bytes) === text ? bytes : undefined;
}
