-- Rights: where an image came from, what it may be used for, and when that
-- runs out. All nullable: a row without them is a file nobody has described
-- yet, not an error. `expires_at` is a date (YYYY-MM-DD, compared as text);
-- the daily expiry run retires every file whose date has passed, and the
-- resizer, given the database, answers 410 for it. Additive only.

ALTER TABLE assets ADD COLUMN licence TEXT;
ALTER TABLE assets ADD COLUMN source_url TEXT;
ALTER TABLE assets ADD COLUMN restrictions TEXT;
ALTER TABLE assets ADD COLUMN expires_at TEXT;
CREATE INDEX assets_expires_at ON assets (expires_at);
