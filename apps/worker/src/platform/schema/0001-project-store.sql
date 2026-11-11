-- One project's ProjectStore (D-3), its first schema step. Shaped by spike S1
-- (docs/reviews/2026-10-20-spike-s1.md) and D-20. Every store's lifetime is in
-- docs/data-model.md. Applied steps never change: a change is a new step.
-- The step runner keeps its own record in store_meta, outside the steps.

CREATE TABLE persons (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  identified INTEGER NOT NULL DEFAULT 0 CHECK (identified IN (0, 1)),
  properties TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(properties)),
  -- Per property, the event time its value came from and whether it was set once,
  -- so $set keeps the latest time and $set_once the earliest (identity-05, identity-07).
  property_times TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(property_times))
) STRICT;

CREATE TABLE person_distinct_ids (
  distinct_id TEXT PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES persons (id)
) STRICT;

CREATE INDEX person_distinct_ids_person ON person_distinct_ids (person_id);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL UNIQUE,
  event TEXT NOT NULL,
  distinct_id TEXT NOT NULL,
  -- Null for $process_person_profile: false and for cookieless events.
  person_id INTEGER REFERENCES persons (id),
  session_id TEXT,
  ts INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  bot INTEGER NOT NULL DEFAULT 0 CHECK (bot IN (0, 1)),
  -- The page key from enrich-23: host plus path, or null when the URL does not parse.
  page TEXT,
  properties TEXT NOT NULL CHECK (json_valid(properties))
) STRICT;

CREATE INDEX events_ts ON events (ts);
CREATE INDEX events_event_ts ON events (event, ts);
CREATE INDEX events_person_ts ON events (person_id, ts);
CREATE INDEX events_session ON events (session_id);
CREATE INDEX events_distinct ON events (distinct_id);
-- A person's counted events in time order, answered from the index alone (spike S1, retention).
CREATE INDEX events_person_counted ON events (person_id, ts) WHERE bot = 0;

CREATE TABLE salts (
  day TEXT PRIMARY KEY,
  salt BLOB NOT NULL CHECK (length(salt) = 16),
  -- (day + 1) 12:00 UTC, when the day has ended at UTC-12 (D-20, cookieless-04).
  expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE cookieless_sessions (
  hash TEXT PRIMARY KEY,
  day TEXT NOT NULL REFERENCES salts (day),
  session_id TEXT NOT NULL,
  last_ts INTEGER NOT NULL
) STRICT;

CREATE INDEX cookieless_sessions_day ON cookieless_sessions (day);

CREATE TABLE recordings (
  session_id TEXT PRIMARY KEY,
  distinct_id TEXT,
  person_id INTEGER REFERENCES persons (id),
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  active_ms INTEGER NOT NULL DEFAULT 0,
  first_url TEXT,
  clicks INTEGER NOT NULL DEFAULT 0,
  keypresses INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX recordings_start ON recordings (start_ts);
CREATE INDEX recordings_end ON recordings (end_ts);
CREATE INDEX recordings_person ON recordings (person_id);
CREATE INDEX recordings_distinct ON recordings (distinct_id);

CREATE TABLE recording_chunks (
  -- The $snapshot event's uuid, so a retried chunk is stored once (recordings-12).
  uuid TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES recordings (session_id),
  object_key TEXT NOT NULL UNIQUE,
  first_ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  snapshot_path TEXT,
  snapshot_width INTEGER
) STRICT;

CREATE INDEX recording_chunks_order ON recording_chunks (session_id, first_ts, received_at, uuid);
CREATE INDEX recording_chunks_snapshot ON recording_chunks (snapshot_path, snapshot_width, last_ts)
  WHERE snapshot_path IS NOT NULL;

CREATE TABLE heatmap_points (
  id INTEGER PRIMARY KEY,
  -- The $$heatmap event's uuid and the point's place in it, so a retry stores nothing twice (heatmaps-13).
  event_uuid TEXT NOT NULL,
  seq INTEGER NOT NULL,
  host TEXT,
  path TEXT NOT NULL,
  width_band INTEGER NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('click', 'rageclick', 'deadclick')),
  fixed INTEGER NOT NULL CHECK (fixed IN (0, 1)),
  bot INTEGER NOT NULL DEFAULT 0 CHECK (bot IN (0, 1)),
  ts INTEGER NOT NULL,
  session_id TEXT,
  distinct_id TEXT,
  UNIQUE (event_uuid, seq)
) STRICT;

CREATE INDEX heatmap_points_page ON heatmap_points (path, width_band, ts);
CREATE INDEX heatmap_points_ts ON heatmap_points (ts);
CREATE INDEX heatmap_points_distinct ON heatmap_points (distinct_id);

CREATE TABLE counters (
  day TEXT NOT NULL,
  name TEXT NOT NULL CHECK (name IN ('events', 'recording_bytes')),
  value INTEGER NOT NULL,
  PRIMARY KEY (day, name)
) STRICT;
