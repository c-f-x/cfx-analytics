import { BODY_LIMITS } from "@cfanalytics/shared";
import { describe, expect, it } from "vitest";
import { base64Form, gzip, jsonBytes } from "../../../test/helpers/capture.ts";
import { decodeBody, sentLimit } from "./decode.ts";

// Body decoding for the capture paths (intake-10, intake-11, intake-23 to intake-26).

const encoder = new TextEncoder();
const eventLimit = BODY_LIMITS.eventBytes;
const recordingLimit = BODY_LIMITS.recordingBytes;

/** A JSON string value whose UTF-8 text is exactly `bytes` long. */
const jsonOfSize = (bytes: number): Uint8Array => {
  const body = new Uint8Array(bytes);
  body[0] = 0x22;
  body.fill(0x61, 1, bytes - 1);
  body[bytes - 1] = 0x22;
  return body;
};

describe("sentLimit", () => {
  it("intake-25 · an uncompressed JSON body may be as long as its decoded limit", () => {
    expect(sentLimit("application/json", null, eventLimit)).toBe(eventLimit);
    expect(sentLimit("Application/JSON; charset=utf-8", null, eventLimit)).toBe(eventLimit);
  });

  it("intake-25 · a form body may be larger, with room for base64 and its percent-encoding", () => {
    // posthog-js percent-encodes only +, / and = of its base64, so a form
    // body for a decoded body at the limit is about 1.4 times the limit.
    for (const limit of [eventLimit, recordingLimit]) {
      const decoded = new Uint8Array(limit);
      for (let index = 0; index < limit; index += 1) decoded[index] = (index * 131 + 7) % 256;
      const sent = encoder.encode(base64Form(decoded)).byteLength;
      expect(sent).toBeLessThanOrEqual(sentLimit("application/x-www-form-urlencoded", null, limit));
    }
  });

  it("intake-25 · no form body over about 1.7 times the limit is read, so memory stays bounded", () => {
    // 4 times, room for base64 whose every character is percent-encoded, let
    // /s/ read about 100 MB and copy it before checking its size.
    expect(sentLimit("application/x-www-form-urlencoded", null, recordingLimit)).toBeLessThan(
      1.7 * recordingLimit,
    );
  });

  it("intake-25 · any other media type may be gzip, with room to grow slightly", () => {
    const expected = eventLimit + Math.ceil(eventLimit / 1000) + 1024;
    expect(sentLimit("text/plain", null, eventLimit)).toBe(expected);
    expect(sentLimit("application/json", "gzip", eventLimit)).toBe(expected);
  });
});

describe("decodeBody", () => {
  it("intake-23 · an uncompressed JSON body is read as JSON", async () => {
    const body = { api_key: "a-token", batch: [] };
    expect(await decodeBody(jsonBytes(body), "application/json", null, eventLimit)).toEqual({
      ok: true,
      value: { encoding: "json", body },
    });
  });

  it("intake-10 · gzip is recognised by its first bytes, whatever the headers say", async () => {
    const body = { api_key: "a-token", batch: [] };
    const bytes = await gzip(jsonBytes(body));
    expect(await decodeBody(bytes, "text/plain", null, eventLimit)).toEqual({
      ok: true,
      value: { encoding: "gzip-magic", body },
    });
    expect(await decodeBody(bytes, "application/json", null, eventLimit)).toEqual({
      ok: true,
      value: { encoding: "gzip-magic", body },
    });
  });

  it("intake-10 · a Content-Encoding of gzip is trusted", async () => {
    const body = { api_key: "a-token", batch: [] };
    const bytes = await gzip(jsonBytes(body));
    expect(await decodeBody(bytes, "application/json", "gzip", eventLimit)).toEqual({
      ok: true,
      value: { encoding: "gzip-header", body },
    });
  });

  it("intake-11 · a base64 form body is decoded, standard or URL-safe", async () => {
    const body = { api_key: "a-token", batch: [{ event: "$pageview" }] };
    const standard = encoder.encode(base64Form(jsonBytes(body)));
    expect(
      await decodeBody(standard, "application/x-www-form-urlencoded", null, eventLimit),
    ).toEqual({ ok: true, value: { encoding: "base64-form", body } });
    const urlSafe = encoder.encode(base64Form(jsonBytes(body), true));
    expect(
      await decodeBody(urlSafe, "application/x-www-form-urlencoded", null, eventLimit),
    ).toEqual({ ok: true, value: { encoding: "base64-form", body } });
  });

  it("intake-11 · a base64 form body holding gzip is gunzipped", async () => {
    const body = { api_key: "a-token", batch: [{ event: "$pageview" }] };
    const bytes = encoder.encode(base64Form(await gzip(jsonBytes(body))));
    expect(await decodeBody(bytes, "application/x-www-form-urlencoded", null, eventLimit)).toEqual({
      ok: true,
      value: { encoding: "base64-form", body },
    });
  });

  it("intake-24 · an empty body is unreadable at empty", async () => {
    expect(await decodeBody(new Uint8Array(0), "application/json", null, eventLimit)).toEqual({
      ok: false,
      error: { kind: "unreadable", step: "empty" },
    });
  });

  it("intake-24 · corrupt gzip, or a gzip label on bytes that are not gzip, is unreadable at gzip", async () => {
    const corrupt = Uint8Array.from([0x1f, 0x8b, 0xff, 0x00, 0x01, 0x02, 0x03]);
    expect(await decodeBody(corrupt, "text/plain", null, eventLimit)).toEqual({
      ok: false,
      error: { kind: "unreadable", step: "gzip" },
    });
    expect(await decodeBody(jsonBytes({ a: 1 }), "application/json", "gzip", eventLimit)).toEqual({
      ok: false,
      error: { kind: "unreadable", step: "gzip" },
    });
  });

  it("intake-24 · a form body with no data field is unreadable at form", async () => {
    const bytes = encoder.encode("compression=base64");
    expect(await decodeBody(bytes, "application/x-www-form-urlencoded", null, eventLimit)).toEqual({
      ok: false,
      error: { kind: "unreadable", step: "form" },
    });
  });

  it("intake-24 · a form body whose data is not base64 is unreadable at base64", async () => {
    const bytes = encoder.encode("data=!!!not-base64!!!");
    expect(await decodeBody(bytes, "application/x-www-form-urlencoded", null, eventLimit)).toEqual({
      ok: false,
      error: { kind: "unreadable", step: "base64" },
    });
  });

  it("intake-24 · a body that is not UTF-8 is unreadable at utf8", async () => {
    const bytes = Uint8Array.from([0xff, 0xfe, 0xfd]);
    expect(await decodeBody(bytes, "text/plain", null, eventLimit)).toEqual({
      ok: false,
      error: { kind: "unreadable", step: "utf8" },
    });
  });

  it("intake-24 · a body that is not JSON is unreadable at json", async () => {
    const bytes = encoder.encode("{not json");
    expect(await decodeBody(bytes, "application/json", null, eventLimit)).toEqual({
      ok: false,
      error: { kind: "unreadable", step: "json" },
    });
  });

  it("intake-05 · a plain event body one byte over BODY_LIMITS.eventBytes is too large", async () => {
    expect(
      await decodeBody(jsonOfSize(eventLimit + 1), "application/json", null, eventLimit),
    ).toEqual({ ok: false, error: { kind: "too large" } });
  });

  it("intake-25 · a gzip or base64 body that decodes past the limit is too large", async () => {
    const over = new Uint8Array(eventLimit + 1).fill(0x61);
    expect(await decodeBody(await gzip(over), "text/plain", null, eventLimit)).toEqual({
      ok: false,
      error: { kind: "too large" },
    });
    const form = encoder.encode(base64Form(await gzip(over)));
    expect(await decodeBody(form, "application/x-www-form-urlencoded", null, eventLimit)).toEqual({
      ok: false,
      error: { kind: "too large" },
    });
  });

  it("intake-26 · a decoded body of exactly the limit is accepted and one byte more is too large", async () => {
    for (const limit of [eventLimit, recordingLimit]) {
      const exact = await decodeBody(jsonOfSize(limit), "application/json", null, limit);
      expect(exact.ok).toBe(true);
      if (exact.ok) expect(String(exact.value.body)).toHaveLength(limit - 2);
      expect(await decodeBody(jsonOfSize(limit + 1), "application/json", null, limit)).toEqual({
        ok: false,
        error: { kind: "too large" },
      });
    }
  });
});
