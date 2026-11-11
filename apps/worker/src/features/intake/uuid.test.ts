import { describe, expect, it } from "vitest";
import { isUuid, uuidV7 } from "./uuid.ts";

// Event ids (intake-31): an event keeps a valid uuid and gets a UUIDv7 otherwise.

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("isUuid", () => {
  it("intake-31 · 8-4-4-4-12 hex digits are a uuid, in lower or upper case", () => {
    expect(isUuid("019302a1-7c00-7000-8000-000000000001")).toBe(true);
    expect(isUuid("019302A1-7C00-7000-8000-000000000001")).toBe(true);
  });

  it("intake-31 · anything else is not a uuid", () => {
    expect(isUuid("019302a17c0070008000000000000001")).toBe(false);
    expect(isUuid("019302a1-7c00-7000-8000-00000000000")).toBe(false);
    expect(isUuid("019302a1-7c00-7000-8000-00000000000g")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});

describe("uuidV7", () => {
  it("intake-31 · a UUIDv7 carries the time in ms, the version, the variant and the random bytes", () => {
    const now = 1_792_580_400_000;
    const random = Uint8Array.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99]);
    const uuid = uuidV7(now, random);
    expect(uuid).toMatch(UUID_V7);
    expect(isUuid(uuid)).toBe(true);
    const hex = uuid.replaceAll("-", "");
    expect(Number.parseInt(hex.slice(0, 12), 16)).toBe(now);
    expect(hex.slice(12, 16)).toBe("7011");
    expect(hex.slice(16, 20)).toBe("a233");
    expect(hex.slice(20)).toBe("445566778899");
  });

  it("intake-31 · the variant bits are set whatever the random bytes hold", () => {
    const uuid = uuidV7(1_792_580_400_000, new Uint8Array(10).fill(0xff));
    const hex = uuid.replaceAll("-", "");
    expect(["8", "9", "a", "b"]).toContain(hex.charAt(16));
  });

  it("intake-31 · different random bytes give different ids", () => {
    const now = 1_792_580_400_000;
    const first = uuidV7(now, new Uint8Array(10).fill(1));
    const second = uuidV7(now, new Uint8Array(10).fill(2));
    expect(first).not.toBe(second);
  });
});
