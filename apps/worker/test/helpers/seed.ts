import type { JsonObject } from "@cfanalytics/shared";
import { DAY_MS, inStore, newUuid, T0 } from "./capture.ts";
import { withinHang } from "./hang.ts";

// Rows written straight into a ProjectStore's tables with plain SQL, for the
// tests of wave 4, which read and delete what earlier waves store: the query
// kinds, the sweep and deletion by person. A test sets every column it cares
// about, such as a person, a bot flag or an age past retention, which the
// capture path would decide for itself. Rows of `recordings`,
// `recording_chunks` and `heatmap_points` come from ./replay.ts
// (snapshotsDirect) and ./capture.ts (ingestDirect with points).

/** One event row. Absent fields take the defaults seedEvents names. */
export interface SeedEvent {
  ts: number;
  event?: string;
  distinctId?: string;
  personId?: number | null;
  sessionId?: string | null;
  bot?: boolean;
  page?: string | null;
  properties?: JsonObject;
  uuid?: string;
  /** Defaults to ts. */
  receivedAt?: number;
}

/**
 * Inserts events in the order given, so a later one gets a greater id
 * (storage order, query-23), and answers their ids. Defaults: event
 * "$pageview", distinct id "user-1", no person, no session, not a bot, no
 * page, properties {}, a fresh uuid, received at ts. A personId must name a
 * person seedPerson made.
 */
export async function seedEvents(
  projectId: string,
  events: readonly SeedEvent[],
): Promise<number[]> {
  return inStore(projectId, (sql, storage) =>
    storage.transactionSync(() =>
      events.map((row) => {
        const inserted = sql
          .exec(
            `INSERT INTO events (uuid, event, distinct_id, person_id, session_id, ts, received_at, bot, page, properties)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            row.uuid ?? newUuid(),
            row.event ?? "$pageview",
            row.distinctId ?? "user-1",
            row.personId ?? null,
            row.sessionId ?? null,
            row.ts,
            row.receivedAt ?? row.ts,
            row.bot === true ? 1 : 0,
            row.page ?? null,
            JSON.stringify(row.properties ?? {}),
          )
          .one();
        return Number(inserted.id);
      }),
    ),
  );
}

/**
 * Inserts one identified person, created at T0, with these distinct ids and
 * properties, and answers its id. Its events come from seedEvents with
 * `personId`.
 */
export async function seedPerson(
  projectId: string,
  distinctIds: readonly string[],
  properties: JsonObject = {},
): Promise<number> {
  return inStore(projectId, (sql, storage) =>
    storage.transactionSync(() => {
      const person = sql
        .exec(
          "INSERT INTO persons (created_at, identified, properties) VALUES (?, 1, ?) RETURNING id",
          T0,
          JSON.stringify(properties),
        )
        .one();
      const id = Number(person.id);
      for (const distinctId of distinctIds) {
        sql.exec(
          "INSERT INTO person_distinct_ids (distinct_id, person_id) VALUES (?, ?)",
          distinctId,
          id,
        );
      }
      return id;
    }),
  );
}

/** The size and time span of a generated fixture. */
export interface FixtureShape {
  events: number;
  persons: number;
  /** The events spread evenly over [end - days, end). */
  days: number;
  end: number;
}

/** Spike S1's size (D-18, query-09): 2,000,000 events, 20,000 people, 13 months up to T0. */
export const S1_FIXTURE: FixtureShape = {
  events: 2_000_000,
  persons: 20_000,
  days: 395,
  end: T0,
};

/** Rows per transaction while generating; spike S1 loaded in transactions of this order. */
const FIXTURE_BATCH = 50_000;

/**
 * Fills an empty store with a fixture generated inside the object, each row
 * a pure function of its index i, as spike S1 did. About 30 s for S1's size
 * on a quiet machine and over two minutes on a busy one, so a test seeds it
 * once per file, in beforeAll with no timeout. Each batch is its own call
 * into the object, within a hang deadline (./hang.ts).
 *
 * People: ids 1 to `persons`, identified, created at the fixture's start,
 * distinct id "user-<n>", properties {"plan": "free" | "pro" | "team",
 * "email": "user-<n>@example.com"}.
 *
 * Event i, in time order, ts = start + floor(i * span / events):
 * - event: by i mod 10, 0 to 3 "$pageview", 4 "$pageleave", 5
 *   "$autocapture", else "event_<i mod 47>": 50 names in all.
 * - i mod 10 = 9: cookieless, no person, distinct id "cookieless_" and the
 *   16 hex digits of i mod 50,000. Else person (i * 7919 mod persons) + 1,
 *   distinct id "user-<person>".
 * - bot when i mod 50 = 1; session "s-<floor(i / 30)>"; page
 *   "www.example.com/page-<i mod 100>".
 * - properties: $current_url, $pathname "/page-<i mod 100>", $host
 *   "www.example.com", $browser Chrome, Safari or Firefox and
 *   $browser_version "<100 + i mod 30>.0", $os, $device_type Desktop, Mobile
 *   or Tablet, $geoip_country_code one of ten, $referring_domain "$direct"
 *   for i mod 4 = 0 else "ref-<i mod 25>.com", utm_campaign
 *   "campaign-<i mod 5>" for i mod 7 = 0. $pageview and $pageleave events
 *   also carry $prev_pageview_pathname "/page-<(i + 1) mod 100>",
 *   $prev_pageview_id "pv-<floor(i / 2)>" and
 *   $prev_pageview_max_content_percentage ((i * 37) mod 101) / 100.
 * Answers the fixture's time span.
 */
export async function seedFixture(
  projectId: string,
  shape: FixtureShape = S1_FIXTURE,
): Promise<{ from: number; to: number }> {
  const span = shape.days * DAY_MS;
  const start = shape.end - span;
  const people = inStore(projectId, (sql, storage) => {
    storage.transactionSync(() => {
      sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < CAST(? AS INTEGER))
         INSERT INTO persons (id, created_at, identified, properties)
         SELECT i, ?, 1, json_object(
           'plan', CASE i % 3 WHEN 0 THEN 'free' WHEN 1 THEN 'pro' ELSE 'team' END,
           'email', 'user-' || i || '@example.com')
         FROM n`,
        shape.persons,
        start,
      );
      sql.exec(
        `INSERT INTO person_distinct_ids (distinct_id, person_id)
         SELECT 'user-' || id, id FROM persons`,
      );
    });
  });
  await withinHang(people, "the fixture's people");
  const batches = Math.ceil(shape.events / FIXTURE_BATCH);
  for (let batch = 0; batch < batches; batch += 1) {
    const first = batch * FIXTURE_BATCH;
    const last = Math.min(first + FIXTURE_BATCH, shape.events) - 1;
    const events = inStore(projectId, (sql, storage) => {
      storage.transactionSync(() => {
        sql.exec(
          `WITH RECURSIVE n(i) AS (
             SELECT CAST(? AS INTEGER) UNION ALL SELECT i + 1 FROM n WHERE i < CAST(? AS INTEGER))
           INSERT INTO events (uuid, event, distinct_id, person_id, session_id, ts, received_at, bot, page, properties)
           SELECT
             printf('%08x-0000-7000-8000-%012x', i, i),
             CASE WHEN i % 10 < 4 THEN '$pageview' WHEN i % 10 = 4 THEN '$pageleave'
                  WHEN i % 10 = 5 THEN '$autocapture' ELSE 'event_' || (i % 47) END,
             CASE WHEN i % 10 = 9 THEN 'cookieless_' || printf('%016x', i % 50000)
                  ELSE 'user-' || ((i * 7919) % CAST(? AS INTEGER) + 1) END,
             CASE WHEN i % 10 = 9 THEN NULL ELSE (i * 7919) % CAST(? AS INTEGER) + 1 END,
             's-' || (i / 30),
             CAST(? AS INTEGER) + (i * CAST(? AS INTEGER)) / CAST(? AS INTEGER),
             CAST(? AS INTEGER) + (i * CAST(? AS INTEGER)) / CAST(? AS INTEGER),
             CASE WHEN i % 50 = 1 THEN 1 ELSE 0 END,
             'www.example.com/page-' || (i % 100),
             json_patch(json_patch(
               json_object(
                 '$current_url', 'https://www.example.com/page-' || (i % 100),
                 '$pathname', '/page-' || (i % 100),
                 '$host', 'www.example.com',
                 '$browser', CASE i % 3 WHEN 0 THEN 'Chrome' WHEN 1 THEN 'Safari' ELSE 'Firefox' END,
                 '$browser_version', (100 + i % 30) || '.0',
                 '$os', CASE i % 3 WHEN 0 THEN 'Mac OS X' WHEN 1 THEN 'iOS' ELSE 'Windows' END,
                 '$device_type', CASE i % 3 WHEN 0 THEN 'Desktop' WHEN 1 THEN 'Mobile' ELSE 'Tablet' END,
                 '$geoip_country_code', substr('NOSEDKDEGBUSFRESITNL', (i % 10) * 2 + 1, 2),
                 '$referring_domain', CASE WHEN i % 4 = 0 THEN '$direct' ELSE 'ref-' || (i % 25) || '.com' END),
               CASE WHEN i % 7 = 0 THEN json_object('utm_campaign', 'campaign-' || (i % 5)) ELSE '{}' END),
               CASE WHEN i % 10 < 5 THEN json_object(
                 '$prev_pageview_pathname', '/page-' || ((i + 1) % 100),
                 '$prev_pageview_id', 'pv-' || (i / 2),
                 '$prev_pageview_max_content_percentage', ((i * 37) % 101) / 100.0)
               ELSE '{}' END)
           FROM n`,
          first,
          last,
          shape.persons,
          shape.persons,
          start,
          span,
          shape.events,
          start,
          span,
          shape.events,
        );
      });
    });
    // One batch at a time: each runs inside the one object, in order.
    // oxlint-disable-next-line no-await-in-loop
    await withinHang(events, `batch ${String(batch + 1)} of ${String(batches)} of the fixture`);
  }
  return { from: start, to: shape.end };
}
