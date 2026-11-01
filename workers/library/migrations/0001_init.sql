-- The media library. The bucket is the only record of which files exist;
-- `assets` holds what the library knows about a key. A key with no row is
-- still listed (bucket-first) and shown as unfiled. Migrations are additive:
-- nothing here rewrites a row.

CREATE TABLE assets (
  key          TEXT PRIMARY KEY,                -- the R2 key, the only identity
  etag         TEXT,                            -- from the listing; MD5 for single-part uploads
  sha256       TEXT,                            -- known for uploads made here, null otherwise
  bytes        INTEGER,
  content_type TEXT,
  width        INTEGER,
  height       INTEGER,
  subject      TEXT,                            -- null = unfiled
  tags         TEXT NOT NULL DEFAULT '[]',      -- JSON array of strings
  alt_default  TEXT NOT NULL DEFAULT '',
  credit       TEXT,
  source       TEXT NOT NULL,                   -- 'upload' (through the library) | 'other'
  first_seen   TEXT NOT NULL,
  uploaded_by  TEXT,
  filed_by     TEXT,
  filed_at     TEXT,
  retired      INTEGER NOT NULL DEFAULT 0,
  retired_note TEXT
);
CREATE INDEX assets_subject ON assets (subject);
CREATE INDEX assets_etag ON assets (etag);
CREATE INDEX assets_sha256 ON assets (sha256);

-- Every write, with the Access identity that made it.
CREATE TABLE audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  ok     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX audit_log_at ON audit_log (at DESC);
