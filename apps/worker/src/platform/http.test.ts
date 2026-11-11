import { describe, expect, it } from "vitest";
import { readBody } from "./http.ts";

const encoder = new TextEncoder();
const url = "https://intake.test/e/";
const tooLarge = { ok: false, error: { kind: "too_large" } };

/** A POST whose body is a stream, so it carries no Content-Length of its own. */
function streamed(chunks: readonly Uint8Array[], declaredLength?: string): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const headers = declaredLength === undefined ? {} : { "content-length": declaredLength };
  return new Request(url, { method: "POST", headers, body: stream, duplex: "half" } as RequestInit);
}

describe("readBody", () => {
  it("intake-25 · a body under the limit is returned as its bytes", async () => {
    expect(await readBody(streamed([encoder.encode("hello")]), 5)).toEqual({
      ok: true,
      value: encoder.encode("hello"),
    });
  });

  it("intake-25 · a declared Content-Length over the limit is refused without reading the body", async () => {
    let pulls = 0;
    // A high-water mark of 0 stops the stream pulling ahead before anyone reads.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(encoder.encode("x"));
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request(url, {
      method: "POST",
      headers: { "content-length": "9" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(await readBody(request, 8)).toEqual(tooLarge);
    expect(pulls).toBe(0);
  });

  it("intake-25 · a stream that passes the limit is refused", async () => {
    expect(await readBody(streamed([new Uint8Array(9)]), 8)).toEqual(tooLarge);
  });

  it("intake-25 · a body of exactly the limit is read", async () => {
    const limit = 20 * 1024 * 1024;
    const result = await readBody(streamed([new Uint8Array(limit)]), limit);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.byteLength).toBe(limit);
  });

  it("intake-25 · a body of 20 MiB plus one byte is refused", async () => {
    const limit = 20 * 1024 * 1024;
    expect(await readBody(streamed([new Uint8Array(limit + 1)]), limit)).toEqual(tooLarge);
  });

  it("intake-25 · a body that fails while reading is an unreadable error value", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("connection reset"));
      },
    });
    const request = new Request(url, {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);
    expect(await readBody(request, 8)).toEqual({ ok: false, error: { kind: "unreadable" } });
  });
});
