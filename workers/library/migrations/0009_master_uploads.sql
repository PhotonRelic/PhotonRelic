-- Master uploads in flight, and the library's own locks.
--
-- A master upload is started by the library (it signs the URLs) and finished
-- by the library (it checks the object and links it). Between the two the
-- bytes travel from the browser to the bucket on their own. This table is the
-- record of what the library started and who started it, so that completing
-- or aborting an upload acts only on an upload this library began: a
-- completion whose declared size does not match removes only an object that
-- this flow created, never a master already on file, and an abort cancels
-- only the upload it names.
CREATE TABLE master_uploads (
  master_key TEXT PRIMARY KEY,
  key        TEXT NOT NULL,
  upload_id  TEXT,
  actor      TEXT NOT NULL,
  started_at TEXT NOT NULL
);

-- One row per operation that must not run twice at once (a Rescan walks the
-- whole bucket and rebuilds the search index). A lock older than its holder
-- could plausibly still be running is taken over, so a Worker that died
-- mid-way does not block the next run forever.
CREATE TABLE locks (
  name     TEXT PRIMARY KEY,
  actor    TEXT NOT NULL,
  since    TEXT NOT NULL
);
