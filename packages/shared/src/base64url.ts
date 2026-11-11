// Base64url (RFC 4648 section 5, no padding): the one home for JWT parts,
// project tokens and query cursors. Pure, and written out rather than built on
// btoa and atob, so it needs no runtime's globals.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Each character's six bits; "+" and "/" read as their URL forms. -1 for any other character. */
const VALUES: readonly number[] = (() => {
  const values = Array.from({ length: 128 }, () => -1);
  for (let index = 0; index < ALPHABET.length; index += 1)
    values[ALPHABET.charCodeAt(index)] = index;
  values["+".charCodeAt(0)] = 62;
  values["/".charCodeAt(0)] = 63;
  return values;
})();

/** `bytes` as base64url text, with no padding. */
export function bytesToBase64url(bytes: Uint8Array): string {
  let text = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const group = (first << 16) | (second << 8) | third;
    const left = bytes.length - index;
    text += ALPHABET[(group >> 18) & 63] ?? "";
    text += ALPHABET[(group >> 12) & 63] ?? "";
    if (left > 1) text += ALPHABET[(group >> 6) & 63] ?? "";
    if (left > 2) text += ALPHABET[group & 63] ?? "";
  }
  return text;
}

/** The bytes of base64 text in either alphabet, padded or not, or null when it is not base64. */
export function base64urlToBytes(text: string): Uint8Array | null {
  const body = text.replace(/=+$/, "");
  if (body.length % 4 === 1) return null;
  const bytes = new Uint8Array(Math.floor((body.length * 3) / 4));
  let written = 0;
  let group = 0;
  let bits = 0;
  for (let index = 0; index < body.length; index += 1) {
    const value = VALUES[body.charCodeAt(index)] ?? -1;
    if (value < 0) return null;
    group = (group << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[written] = (group >> bits) & 0xff;
      written += 1;
    }
  }
  return bytes;
}
