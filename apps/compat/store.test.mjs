// @ts-check

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  decodeRecordingObject,
  mapChunkRow,
  mapEventRow,
  mapObjectRow,
  mapPersonLink,
  mapPointRow,
  resolveObjectFile,
} from "./store.mjs";

/**
 * @param {Record<string, unknown>} overrides
 * @returns {Record<string, unknown>}
 */
function row(overrides = {}) {
  return {
    uuid: "e-1",
    event: "$pageview",
    distinct_id: "anon-1",
    person_id: 3,
    ts: 1_700_000_000_000,
    properties: JSON.stringify({ $lib: "posthog-js" }),
    ...overrides,
  };
}

void test("an events row maps to what a check reads", () => {
  const mapped = mapEventRow(row());
  assert.deepEqual(mapped, {
    ok: true,
    value: {
      uuid: "e-1",
      event: "$pageview",
      distinctId: "anon-1",
      personId: 3,
      ts: 1_700_000_000_000,
      properties: { $lib: "posthog-js" },
    },
  });
});

void test("an events row accepts a null person", () => {
  const mapped = mapEventRow(row({ person_id: null }));
  assert.equal(mapped.ok, true);
  assert.equal(mapped.ok ? mapped.value.personId : "unread", null);
});

void test("an events row with properties that are not JSON is reported, not thrown", () => {
  const mapped = mapEventRow(row({ properties: "not json" }));
  assert.deepEqual(mapped, { ok: false, error: "event e-1 has properties that are not JSON" });
});

void test("an events row with a missing column is reported", () => {
  assert.equal(mapEventRow(row({ uuid: undefined })).ok, false);
  assert.equal(mapEventRow(row({ ts: "1" })).ok, false);
  assert.equal(mapEventRow(row({ person_id: "3" })).ok, false);
  assert.equal(mapEventRow(null).ok, false);
});

void test("a person_distinct_ids row maps to an id and its person", () => {
  assert.deepEqual(mapPersonLink({ distinct_id: "user-1", person_id: 4 }), {
    ok: true,
    value: { distinctId: "user-1", personId: 4 },
  });
  assert.equal(mapPersonLink({ distinct_id: "user-1" }).ok, false);
});

void test("an R2 index row maps to its key and blob id", () => {
  assert.deepEqual(mapObjectRow({ key: "posthog-1/chunk.ndjson", blob_id: "ab12" }), {
    ok: true,
    value: { key: "posthog-1/chunk.ndjson", blobId: "ab12" },
  });
  assert.equal(mapObjectRow({ key: "posthog-1/chunk.ndjson" }).ok, false);
});

void test("an object file is joined under blobs, and a blob id that is a path is refused", () => {
  assert.equal(
    resolveObjectFile("/state/v3/r2/bucket", "ab12"),
    path.join("/state/v3/r2/bucket", "blobs", "ab12"),
  );
  assert.equal(resolveObjectFile("/state/v3/r2/bucket", "../../etc/passwd"), null);
  assert.equal(resolveObjectFile("/state/v3/r2/bucket", ""), null);
});

/**
 * @param {Record<string, unknown>} overrides
 * @returns {Record<string, unknown>}
 */
function pointRow(overrides = {}) {
  return {
    event_uuid: "e-2",
    seq: 0,
    host: "127.0.0.1:8080",
    path: "/normal.html",
    width_band: 1200,
    x: 10,
    y: 20,
    kind: "click",
    fixed: 0,
    bot: 0,
    ts: 1_700_000_000_000,
    session_id: "s-1",
    distinct_id: "anon-1",
    ...overrides,
  };
}

/**
 * @param {Record<string, unknown>} overrides
 * @returns {Record<string, unknown>}
 */
function chunkRow(overrides = {}) {
  return {
    uuid: "c-1",
    session_id: "s-1",
    object_key: "p-1/s-1/1-000.ndjson.gz",
    first_ts: 1_700_000_000_000,
    last_ts: 1_700_000_000_100,
    bytes: 42,
    snapshot_path: "/normal.html",
    snapshot_width: 1280,
    ...overrides,
  };
}

void test("a heatmap_points row maps to what a check reads", () => {
  assert.deepEqual(mapPointRow(pointRow()), {
    ok: true,
    value: {
      eventUuid: "e-2",
      seq: 0,
      host: "127.0.0.1:8080",
      path: "/normal.html",
      widthBand: 1200,
      x: 10,
      y: 20,
      kind: "click",
      fixed: false,
      bot: false,
      ts: 1_700_000_000_000,
      sessionId: "s-1",
      distinctId: "anon-1",
    },
  });
});

void test("a heatmap point accepts a null host, session and distinct id", () => {
  const mapped = mapPointRow(pointRow({ host: null, session_id: null, distinct_id: null }));
  assert.equal(mapped.ok, true);
  assert.deepEqual(
    mapped.ok ? [mapped.value.host, mapped.value.sessionId, mapped.value.distinctId] : [],
    [null, null, null],
  );
});

void test("a heatmap point with a bad flag or column is reported", () => {
  assert.equal(mapPointRow(pointRow({ fixed: 2 })).ok, false);
  assert.equal(mapPointRow(pointRow({ bot: null })).ok, false);
  assert.equal(mapPointRow(pointRow({ x: "10" })).ok, false);
  assert.equal(mapPointRow(null).ok, false);
});

void test("a recording_chunks row maps with its object and snapshot fields", () => {
  assert.deepEqual(mapChunkRow(chunkRow()), {
    ok: true,
    value: {
      uuid: "c-1",
      sessionId: "s-1",
      objectKey: "p-1/s-1/1-000.ndjson.gz",
      firstTs: 1_700_000_000_000,
      lastTs: 1_700_000_000_100,
      byteSize: 42,
      snapshotPath: "/normal.html",
      snapshotWidth: 1280,
    },
  });
  const noSnapshot = mapChunkRow(chunkRow({ snapshot_path: null, snapshot_width: null }));
  assert.equal(noSnapshot.ok, true);
  assert.equal(noSnapshot.ok ? noSnapshot.value.snapshotWidth : "unread", null);
});

void test("a recording_chunks row with a missing column is reported", () => {
  assert.equal(mapChunkRow(chunkRow({ object_key: undefined })).ok, false);
  assert.equal(mapChunkRow(chunkRow({ first_ts: "1" })).ok, false);
  assert.equal(mapChunkRow(chunkRow({ snapshot_width: "1280" })).ok, false);
});

void test("a recording object decodes from gzip NDJSON, one event per line", () => {
  const body = gzipSync('{"type":2,"timestamp":100}\n\n{"type":3,"timestamp":110}\n');
  assert.deepEqual(decodeRecordingObject(body), [
    { type: 2, timestamp: 100 },
    { type: 3, timestamp: 110 },
  ]);
});

void test("a recording object that is not gzip or NDJSON is an error, not an empty recording", () => {
  assert.throws(() => decodeRecordingObject(Buffer.from("not gzip")), /not gzip/);
  assert.throws(() => decodeRecordingObject(gzipSync("not json\n")), /not NDJSON/);
  assert.throws(() => decodeRecordingObject(gzipSync("[1,2]\n")), /not a JSON object/);
});
