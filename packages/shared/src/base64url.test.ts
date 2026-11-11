import { expect, it } from "vitest";
import { base64urlToBytes, bytesToBase64url } from "./base64url.ts";

// Base64url, one home for the JWT parts, project tokens and query cursors
// (projects-04, platform-06, query-48). RFC 4648 section 5, no padding.

it("query-48 · bytes encode in the URL alphabet with no padding", () => {
  expect(bytesToBase64url(Uint8Array.from([0xfb, 0xff]))).toBe("-_8");
  expect(bytesToBase64url(Uint8Array.from([0x68, 0x69]))).toBe("aGk");
  expect(bytesToBase64url(new Uint8Array())).toBe("");
});

it("query-48 · every byte value survives a round trip, at a size a spread would overflow", () => {
  const bytes = Uint8Array.from({ length: 200_000 }, (_value, index) => index % 256);
  const decoded = base64urlToBytes(bytesToBase64url(bytes));
  expect(decoded).toEqual(bytes);
});

it("query-49 · text that is not base64 decodes to null; either alphabet and padding are read", () => {
  expect(base64urlToBytes("not base64!")).toBeNull();
  expect(base64urlToBytes("-_8")).toEqual(Uint8Array.from([0xfb, 0xff]));
  expect(base64urlToBytes("+/8=")).toEqual(Uint8Array.from([0xfb, 0xff]));
});
