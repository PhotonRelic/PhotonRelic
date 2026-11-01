-- Search over the capture data too: the camera and lens join the index, so
-- "nikon" or "85mm" finds the files shot with them, and the Search page can
-- offer the cameras among the matches as a facet.
--
-- An FTS5 table's columns are fixed when it is created, so the index is made
-- again with the two extra columns and its triggers are redefined to carry
-- them. The index holds only tokens; the rows of `assets` are not touched,
-- and the rebuild at the end fills the new index from them.

DROP TRIGGER IF EXISTS assets_fts_ai;
DROP TRIGGER IF EXISTS assets_fts_ad;
DROP TRIGGER IF EXISTS assets_fts_au;
DROP TABLE IF EXISTS assets_fts;

CREATE VIRTUAL TABLE assets_fts USING fts5(
  key,
  subject,
  tags,
  alt_default,
  credit,
  camera,
  lens,
  content='assets',
  content_rowid='rowid'
);

CREATE TRIGGER assets_fts_ai AFTER INSERT ON assets BEGIN
  INSERT INTO assets_fts (rowid, key, subject, tags, alt_default, credit, camera, lens)
  VALUES (new.rowid, new.key, new.subject, new.tags, new.alt_default, new.credit, new.camera, new.lens);
END;

CREATE TRIGGER assets_fts_ad AFTER DELETE ON assets BEGIN
  INSERT INTO assets_fts (assets_fts, rowid, key, subject, tags, alt_default, credit, camera, lens)
  VALUES ('delete', old.rowid, old.key, old.subject, old.tags, old.alt_default, old.credit, old.camera, old.lens);
END;

-- Only a change to an indexed column re-indexes the row, as before; an upload
-- that completes a row's capture data counts as such a change.
CREATE TRIGGER assets_fts_au AFTER UPDATE OF key, subject, tags, alt_default, credit, camera, lens ON assets BEGIN
  INSERT INTO assets_fts (assets_fts, rowid, key, subject, tags, alt_default, credit, camera, lens)
  VALUES ('delete', old.rowid, old.key, old.subject, old.tags, old.alt_default, old.credit, old.camera, old.lens);
  INSERT INTO assets_fts (rowid, key, subject, tags, alt_default, credit, camera, lens)
  VALUES (new.rowid, new.key, new.subject, new.tags, new.alt_default, new.credit, new.camera, new.lens);
END;

INSERT INTO assets_fts (assets_fts) VALUES ('rebuild');
