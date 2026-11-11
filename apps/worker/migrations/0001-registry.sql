-- The D1 registry (D-4): projects, their settings and their secret keys.
-- Ranges repeat packages/shared/src/settings.ts, and projects-06 proves they agree.
-- Applied steps never change (docs/data-model.md, "Schema steps").

CREATE TABLE projects (
  id TEXT PRIMARY KEY CHECK (id GLOB 'p_*' AND length(id) = 18),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 200),
  token TEXT NOT NULL UNIQUE CHECK (token GLOB 'cfa_pk_*' AND length(token) = 50),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  timezone TEXT NOT NULL DEFAULT 'Europe/Oslo' CHECK (length(timezone) BETWEEN 1 AND 64),
  events_retention_days INTEGER NOT NULL DEFAULT 395 CHECK (events_retention_days BETWEEN 1 AND 3650),
  recordings_retention_days INTEGER NOT NULL DEFAULT 30 CHECK (recordings_retention_days BETWEEN 1 AND 365),
  heatmaps_retention_days INTEGER NOT NULL DEFAULT 90 CHECK (heatmaps_retention_days BETWEEN 1 AND 3650),
  daily_event_cap INTEGER NOT NULL DEFAULT 40000 CHECK (daily_event_cap >= 1),
  daily_recording_bytes_cap INTEGER NOT NULL DEFAULT 500000000 CHECK (daily_recording_bytes_cap >= 1),
  recording_enabled INTEGER NOT NULL DEFAULT 0 CHECK (recording_enabled IN (0, 1)),
  recording_sample_rate REAL NOT NULL DEFAULT 1.0 CHECK (recording_sample_rate BETWEEN 0 AND 1),
  recording_min_duration_ms INTEGER NOT NULL DEFAULT 2000 CHECK (recording_min_duration_ms BETWEEN 0 AND 600000),
  heatmaps_enabled INTEGER NOT NULL DEFAULT 0 CHECK (heatmaps_enabled IN (0, 1)),
  autocapture_enabled INTEGER NOT NULL DEFAULT 1 CHECK (autocapture_enabled IN (0, 1)),
  dead_clicks_enabled INTEGER NOT NULL DEFAULT 0 CHECK (dead_clicks_enabled IN (0, 1)),
  internal_rules TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(internal_rules) AND json_type(internal_rules) = 'array'),
  -- A full cap every day of the retention fits under the 9 GB guard at 530 bytes an event (events-11, D-20).
  CHECK (daily_event_cap * events_retention_days <= 16981132)
) STRICT;

CREATE TABLE secret_keys (
  hash TEXT PRIMARY KEY CHECK (length(hash) = 64),
  project_id TEXT NOT NULL REFERENCES projects (id),
  label TEXT NOT NULL CHECK (length(label) <= 100),
  created_at INTEGER NOT NULL,
  last_used_day TEXT
) STRICT;

CREATE INDEX secret_keys_project ON secret_keys (project_id);
