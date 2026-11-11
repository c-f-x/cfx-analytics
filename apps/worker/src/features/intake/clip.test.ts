import type { Json, JsonObject } from "@cfanalytics/shared";
import { CLIP } from "@cfanalytics/shared";
import { describe, expect, it } from "vitest";
import { clipProperties, clipText } from "./clip.ts";

// Clipping at intake (intake-04): over-long values are cut and stored, never refused.

const encoder = new TextEncoder();
const bytesOf = (text: string): number => encoder.encode(text).length;
const stringBytes = (value: Json | undefined): number =>
  typeof value === "string" ? bytesOf(value) : Number.POSITIVE_INFINITY;

const isJsonObject = (value: Json | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nextOf = (value: Json | undefined): Json | undefined =>
  isJsonObject(value) ? value.next : undefined;

const firstOf = (value: Json | undefined): Json | undefined =>
  Array.isArray(value) ? value[0] : undefined;

const isWellFormed = (text: string): boolean => {
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(encoder.encode(text));
    return true;
  } catch {
    return false;
  }
};

describe("clipText", () => {
  it("intake-04 · text that fits is returned unchanged", () => {
    expect(clipText("a pageview", 200)).toBe("a pageview");
  });

  it("intake-04 · text over the limit is cut to at most that many UTF-8 bytes", () => {
    const clipped = clipText("a".repeat(250), 200);
    expect(bytesOf(clipped)).toBeLessThanOrEqual(200);
    expect(clipped).toBe("a".repeat(200));
  });

  it("intake-04 · the cut happens on a character boundary and keeps valid UTF-8", () => {
    const text = `${"a".repeat(199)}é-tail`;
    const clipped = clipText(text, 200);
    expect(bytesOf(clipped)).toBeLessThanOrEqual(200);
    expect(clipped).toBe("a".repeat(199));
    expect(isWellFormed(clipped)).toBe(true);
  });

  it("intake-04 · a surrogate pair is never split", () => {
    const clipped = clipText(`${"a".repeat(198)}😀`, 200);
    expect(bytesOf(clipped)).toBeLessThanOrEqual(200);
    expect(clipped).toBe("a".repeat(198));
    expect(isWellFormed(clipped)).toBe(true);
  });
});

describe("clipProperties", () => {
  it("intake-04 · at most the first propertiesPerEvent keys are kept", () => {
    const properties: JsonObject = {};
    for (let index = 0; index <= CLIP.propertiesPerEvent; index += 1) {
      properties[`key-${index}`] = index;
    }
    const clipped = clipProperties(properties);
    expect(Object.keys(clipped)).toHaveLength(CLIP.propertiesPerEvent);
    expect(clipped["key-0"]).toBe(0);
    expect(clipped[`key-${CLIP.propertiesPerEvent - 1}`]).toBe(CLIP.propertiesPerEvent - 1);
    expect(clipped[`key-${CLIP.propertiesPerEvent}`]).toBeUndefined();
  });

  it("intake-04 · every key is clipped; two keys that clip alike keep the first", () => {
    const longKey = "k".repeat(CLIP.propertyName + 20);
    const [clippedKey] = Object.keys(clipProperties({ [longKey]: "value" }));
    expect(clippedKey).toBeDefined();
    expect(bytesOf(clippedKey ?? "")).toBeLessThanOrEqual(CLIP.propertyName);

    // Exactly the limit, so both keys clip to it and the first is kept.
    const shared = "a".repeat(CLIP.propertyName);
    const clipped = clipProperties({ [`${shared}-one`]: "first", [`${shared}-two`]: "second" });
    expect(Object.keys(clipped)).toEqual([shared]);
    expect(clipped[shared]).toBe("first");
  });

  it("intake-04 · string values are clipped, and URL properties to the URL limit", () => {
    const clipped = clipProperties({
      long: "a".repeat(CLIP.stringValue + 500),
      $current_url: `https://example.com/${"a".repeat(CLIP.url + 500)}`,
      short: "kept",
    });
    expect(stringBytes(clipped.long)).toBeLessThanOrEqual(CLIP.stringValue);
    expect(stringBytes(clipped.$current_url)).toBeLessThanOrEqual(CLIP.url);
    expect(clipped.short).toBe("kept");
  });

  it("intake-04 · an object or array nested deeper than the depth limit becomes null", () => {
    const objectChain: JsonObject = {};
    let cursor = objectChain;
    // The properties object is level 1, so this builds objects at levels 2 to 11.
    for (let level = 2; level <= CLIP.depth + 1; level += 1) {
      const next: JsonObject = {};
      cursor.next = next;
      cursor = next;
    }
    const clippedObject = clipProperties(objectChain);
    let node: Json | undefined = clippedObject;
    for (let level = 3; level <= CLIP.depth + 1; level += 1) node = nextOf(node);
    // node is the level 10 object, kept; the level 11 object below it is cut off.
    expect(node).toEqual({ next: null });
    expect(nextOf(node)).toBeNull();

    let arrayChain: Json = 1;
    for (let level = 2; level <= CLIP.depth + 1; level += 1) arrayChain = [arrayChain];
    const clippedArray = clipProperties({ a: arrayChain });
    let nested: Json | undefined = clippedArray.a;
    for (let level = 3; level <= CLIP.depth; level += 1) nested = firstOf(nested);
    expect(firstOf(nested)).toBeNull();
  });

  it("intake-04 · numbers, booleans and null are kept as they are", () => {
    const clipped = clipProperties({
      count: 7,
      big: 12_345_678_901,
      yes: true,
      no: false,
      nothing: null,
    });
    expect(clipped).toEqual({
      count: 7,
      big: 12_345_678_901,
      yes: true,
      no: false,
      nothing: null,
    });
  });
});
