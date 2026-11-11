import { expect, it } from "vitest";
import {
  inStore,
  MINUTE_MS,
  storedSalts,
  storedSessions,
  T0,
} from "../../../test/helpers/capture.ts";
import { newProjectId } from "../../../test/helpers/registry.ts";
import { pruneSalts, saltForDay, sessionFor } from "./store.ts";

// The `salts` and `cookieless_sessions` tables through a real ProjectStore's
// SQL (cookieless-04, cookieless-17, cookieless-18). Each test has its own
// project, and every time is passed in.

const DAY = "2026-10-21";
const NEXT_DAY = "2026-10-22";
// Day D ends at UTC-12 when it is 12:00 UTC on D+1 (D-20).
const DAY_EXPIRY = Date.UTC(2026, 9, 22, 12, 0, 0);
const NEXT_EXPIRY = Date.UTC(2026, 9, 23, 12, 0, 0);
const SALT_ONE = new Uint8Array(16).fill(1);
const SALT_TWO = new Uint8Array(16).fill(2);

it("cookieless-04 · saltForDay keeps day D's salt before (D+1) 12:00 UTC and deletes it at that moment", async () => {
  const kept = newProjectId();
  await inStore(kept, (sql) => {
    expect(saltForDay(sql, DAY, DAY_EXPIRY, T0, () => SALT_ONE)).toEqual({
      ok: true,
      value: SALT_ONE,
    });
    expect(saltForDay(sql, NEXT_DAY, NEXT_EXPIRY, DAY_EXPIRY - 1, () => SALT_TWO)).toEqual({
      ok: true,
      value: SALT_TWO,
    });
  });
  expect((await storedSalts(kept)).map((row) => row.day)).toEqual([DAY, NEXT_DAY]);

  const swept = newProjectId();
  await inStore(swept, (sql) => {
    saltForDay(sql, DAY, DAY_EXPIRY, T0, () => SALT_ONE);
    saltForDay(sql, NEXT_DAY, NEXT_EXPIRY, DAY_EXPIRY, () => SALT_TWO);
  });
  expect((await storedSalts(swept)).map((row) => row.day)).toEqual([NEXT_DAY]);
});

it("cookieless-04 · pruneSalts keeps day D's salt and its sessions until (D+1) 12:00 UTC", async () => {
  const project = newProjectId();
  await inStore(project, (sql) => {
    sql.exec(
      "INSERT INTO salts (day, salt, expires_at) VALUES (?, ?, ?)",
      DAY,
      SALT_ONE.buffer,
      DAY_EXPIRY,
    );
    sql.exec(
      "INSERT INTO cookieless_sessions (hash, day, session_id, last_ts) VALUES (?, ?, ?, ?)",
      "hash-1",
      DAY,
      "session-1",
      T0,
    );
  });

  expect(await inStore(project, (sql) => pruneSalts(sql, DAY_EXPIRY - 1))).toEqual({
    salts: 0,
    sessions: 0,
  });
  expect(await storedSalts(project)).toHaveLength(1);
  expect(await storedSessions(project)).toHaveLength(1);

  expect(await inStore(project, (sql) => pruneSalts(sql, DAY_EXPIRY))).toEqual({
    salts: 1,
    sessions: 1,
  });
  expect(await storedSalts(project)).toEqual([]);
  expect(await storedSessions(project)).toEqual([]);
});

it("cookieless-17 · a made salt that is not 16 bytes is a SaltError and stores nothing", async () => {
  const project = newProjectId();
  const result = await inStore(project, (sql) =>
    saltForDay(sql, DAY, DAY_EXPIRY, T0, () => new Uint8Array(15)),
  );

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("saltForDay accepted a 15-byte salt");
  expect(result.error.kind).toBe("salt unavailable");
  expect(await storedSalts(project)).toEqual([]);
});

it("cookieless-18 · sessionFor joins an event inside the window and never moves last_ts back", async () => {
  const project = newProjectId();
  await inStore(project, (sql) => {
    sql.exec(
      "INSERT INTO salts (day, salt, expires_at) VALUES (?, ?, ?)",
      DAY,
      SALT_ONE.buffer,
      DAY_EXPIRY,
    );
  });

  // Each call records whether sessionFor asked for a new id.
  const asked: string[] = [];
  const at = (ts: number, newSessionId: string) =>
    inStore(project, (sql) =>
      sessionFor(sql, "hash-1", DAY, ts, () => {
        asked.push(newSessionId);
        return newSessionId;
      }),
    );

  expect(await at(T0, "session-1")).toBe("session-1");
  expect(await at(T0 + 20 * MINUTE_MS, "session-2")).toBe("session-1");
  // 10 minutes before the session's last event: inside the window, joined.
  expect(await at(T0 + 10 * MINUTE_MS, "session-3")).toBe("session-1");
  expect(await storedSessions(project)).toEqual([
    { hash: "hash-1", day: DAY, sessionId: "session-1", lastTs: T0 + 20 * MINUTE_MS },
  ]);
  // Only the event that started the session asked for an id.
  expect(asked).toEqual(["session-1"]);

  // 40 minutes before the session's last event: a session for this event alone.
  expect(await at(T0 - 20 * MINUTE_MS, "session-4")).toBe("session-4");
  expect(await storedSessions(project)).toEqual([
    { hash: "hash-1", day: DAY, sessionId: "session-1", lastTs: T0 + 20 * MINUTE_MS },
  ]);
  expect(asked).toEqual(["session-1", "session-4"]);
});
