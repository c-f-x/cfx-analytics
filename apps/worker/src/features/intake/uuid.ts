// Event ids (intake-31, D-20). An event without a valid uuid gets a UUIDv7.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` is a string of 8-4-4-4-12 hex digits, in lower or upper case. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/**
 * A UUIDv7 in lower case (RFC 9562): the 48-bit `now` in ms, the version 7,
 * then `random` (exactly 10 bytes) with the variant bits set. Pure.
 */
export function uuidV7(now: number, random: Uint8Array): string {
  const bytes = new Uint8Array(16);
  let time = Math.max(0, Math.floor(now));
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = 0x70 | ((random[0] ?? 0) & 0x0f);
  bytes[7] = random[1] ?? 0;
  bytes[8] = 0x80 | ((random[2] ?? 0) & 0x3f);
  bytes[9] = random[3] ?? 0;
  for (let index = 4; index < 10; index += 1) bytes[index + 6] = random[index] ?? 0;

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
