import { isJsonObject } from "@cfanalytics/shared";
import { describe, expect, it } from "vitest";
import { createLogger, type Logger } from "./log.ts";

/** A logger that keeps its lines, so a test can read what would have been written. */
function capture(): { lines: string[]; log: Logger } {
  const lines: string[] = [];
  return { lines, log: createLogger((line) => lines.push(line)) };
}

/** One written line, parsed, with the test failing loudly when it is not a JSON object. */
function parseLine(line: string): Record<string, unknown> {
  const value: unknown = JSON.parse(line);
  if (!isJsonObject(value)) throw new Error(`expected a JSON object, got ${line}`);
  return value;
}

describe("createLogger", () => {
  it("platform-32 · an Authorization header never reaches the log line", () => {
    const { lines, log } = capture();
    log.info("request", { authorization: "Bearer cfa_sk_notarealkey", path: "/api/projects" });
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? "";
    expect(line).not.toContain("Bearer");
    expect(parseLine(line)).toEqual({
      level: "info",
      event: "request",
      authorization: "[redacted]",
      path: "/api/projects",
    });
  });

  it("platform-32 · a plaintext secret key is replaced wherever it appears", () => {
    const { lines, log } = capture();
    const key = "cfa_sk_AbC-123_xyz";
    log.info("key created", { label: "web", key, note: `the key ${key} was created` });
    const line = lines[0] ?? "";
    expect(line).not.toContain(key);
    const written = parseLine(line);
    expect(written.key).toBe("cfa_sk_[redacted]");
    expect(written.note).toBe("the key cfa_sk_[redacted] was created");
    expect(written.label).toBe("web");
  });

  it("platform-32 · header and address fields are redacted at any depth, in any case", () => {
    const { lines, log } = capture();
    log.info("request", {
      headers: {
        Authorization: "Bearer secret",
        COOKIE: "session=1",
        "Set-Cookie": "session=1",
        "X-Forwarded-For": "203.0.113.7",
        "CF-Connecting-IP": "203.0.113.7",
        "X-Real-IP": "203.0.113.7",
        IP: "203.0.113.7",
        $ip: "203.0.113.7",
      },
      events: [{ authorization: "Bearer other", $ip: "198.51.100.2" }],
    });
    const line = lines[0] ?? "";
    const written = parseLine(line);
    const headers = written.headers;
    if (!isJsonObject(headers)) throw new Error("expected the headers field to be an object");
    for (const value of Object.values(headers)) expect(value).toBe("[redacted]");
    const events = written.events;
    if (!Array.isArray(events)) throw new Error("expected the events field to be an array");
    expect(events[0]).toEqual({ authorization: "[redacted]", $ip: "[redacted]" });
    expect(line).not.toContain("203.0.113.7");
    expect(line).not.toContain("198.51.100.2");
  });

  it("platform-32 · a field that cannot be serialised becomes [unserialisable]", () => {
    const { lines, log } = capture();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => log.info("odd", { bad: circular, good: "kept" })).not.toThrow();
    const written = parseLine(lines[0] ?? "");
    expect(written.bad).toBe("[unserialisable]");
    expect(written.good).toBe("kept");
  });

  it("platform-32 · each call writes one JSON line naming its level and event", () => {
    const { lines, log } = capture();
    log.info("started");
    log.error("failed", { code: "x" });
    expect(lines).toHaveLength(2);
    expect(parseLine(lines[0] ?? "")).toEqual({ level: "info", event: "started" });
    expect(parseLine(lines[1] ?? "")).toEqual({ level: "error", event: "failed", code: "x" });
  });
});
