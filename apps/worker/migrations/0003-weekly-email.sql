-- The weekly email (#23, D-40). Each product says whether it is in the
-- weekly email and which confirmed addresses do not get it. The addresses the
-- owner added in the dashboard are kept here; whether each is confirmed is
-- Cloudflare's own record, read when needed. Kept until removed, or the
-- registry is deleted (docs/data-model.md).
ALTER TABLE projects ADD COLUMN weekly_email INTEGER NOT NULL DEFAULT 1 CHECK (weekly_email IN (0, 1));
ALTER TABLE projects ADD COLUMN email_off TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(email_off) AND json_type(email_off) = 'array');

CREATE TABLE email_addresses (
  address TEXT PRIMARY KEY CHECK (length(address) BETWEEN 3 AND 254),
  added_at INTEGER NOT NULL
) STRICT;
