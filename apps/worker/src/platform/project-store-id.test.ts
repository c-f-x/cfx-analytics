import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { projectStore, projectStoreName, storeJurisdiction } from "./project-store-id.ts";

describe("storeJurisdiction", () => {
  it('platform-52 · "eu" addresses the eu jurisdiction, and no value the default placement', () => {
    expect(storeJurisdiction("eu")).toEqual({ ok: true, value: "eu" });
    expect(storeJurisdiction(undefined)).toEqual({ ok: true, value: undefined });
  });

  it("platform-53 · any other value is no region at all", () => {
    for (const value of ["EU", "", " eu", "us", "fedramp", 1, null, true]) {
      expect(storeJurisdiction(value).ok).toBe(false);
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
