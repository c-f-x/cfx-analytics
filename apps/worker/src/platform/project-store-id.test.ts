import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { isLocalUnscoped, projectStore, projectStoreName } from "./project-store-id.ts";

describe("isLocalUnscoped", () => {
  it('platform-16 · only the string "1" turns the local flag on', () => {
    expect(isLocalUnscoped("1")).toBe(true);
    for (const value of [undefined, null, "", "true", "0", " 1", "11", 1, true]) {
      expect(isLocalUnscoped(value)).toBe(false);
    }
  });
});

describe("projectStoreName", () => {
  it("platform-17 · the same project id always names the same store", () => {
    expect(projectStoreName("platform-17-a")).toBe(projectStoreName("platform-17-a"));
  });

  it("platform-17 · two project ids never share a name", () => {
    expect(projectStoreName("platform-17-a")).not.toBe(projectStoreName("platform-17-b"));
  });

  it("platform-17 · the real stores follow those names", () => {
    const first = projectStore(env, "platform-17-a");
    const same = projectStore(env, "platform-17-a");
    const other = projectStore(env, "platform-17-b");
    expect(first.id.toString()).toBe(same.id.toString());
    expect(first.id.toString()).not.toBe(other.id.toString());
  });
});
