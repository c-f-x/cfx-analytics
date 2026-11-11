-- The board's tiles (D-24, projects-40 to projects-44): saved questions per
-- project, in position order. Each spec is a query spec without its range or
-- time zone, checked by tileSpec before it is written. Kept until the tile is
-- removed or the project's rows are purged (docs/data-model.md).
CREATE TABLE board_tiles (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 40),
  project_id TEXT NOT NULL REFERENCES projects (id),
  position INTEGER NOT NULL CHECK (position >= 0),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  spec TEXT NOT NULL CHECK (json_valid(spec) AND json_type(spec) = 'object'),
  standard INTEGER NOT NULL DEFAULT 0 CHECK (standard IN (0, 1)),
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX board_tiles_project ON board_tiles (project_id, position);
