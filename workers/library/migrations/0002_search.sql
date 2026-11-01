-- Search. An FTS5 index over what the library knows about a key: the key
-- itself, its subject, tags, default alt text and credit. It is an
-- external-content table, so the text stays in `assets` and the index holds
-- only tokens; the triggers below keep it in step with every insert, update
-- and delete, and nothing here rewrites a row of `assets`.
--
-- `tags` is indexed as the JSON array it is stored as: the tokenizer treats
-- the brackets, quotes and commas as separators, so only the words remain.
-- A hyphenated tag is indexed as its words, which lets "hero" find
-- "hero-shot" and lets the quoted query "hero-shot" still match as a phrase.
--
-- `assets` has an implicit rowid (its primary key is the text key), and that
-- rowid is what links the index to the row. Only VACUUM can renumber such
-- rowids; D1 never runs it, and a Rescan rebuilds the index anyway.

CREATE VIRTUAL TABLE assets_fts USING fts5(
  key,
  subject,
  tags,
  alt_default,
  credit,
  content='assets',
  content_rowid='rowid'
);

CREATE TRIGGER assets_fts_ai AFTER INSERT ON assets BEGIN
  INSERT INTO assets_fts (rowid, key, subject, tags, alt_default, credit)
  VALUES (new.rowid, new.key, new.subject, new.tags, new.alt_default, new.credit);
END;

-- An external-content index is told what the old row said, so it can remove
-- exactly those tokens; the values come from the row the trigger sees.
CREATE TRIGGER assets_fts_ad AFTER DELETE ON assets BEGIN
  INSERT INTO assets_fts (assets_fts, rowid, key, subject, tags, alt_default, credit)
  VALUES ('delete', old.rowid, old.key, old.subject, old.tags, old.alt_default, old.credit);
END;

-- Only a change to an indexed column re-indexes the row: a Rescan refreshes
-- the etag and size of every row and must not rewrite the whole index each time.
CREATE TRIGGER assets_fts_au AFTER UPDATE OF key, subject, tags, alt_default, credit ON assets BEGIN
  INSERT INTO assets_fts (assets_fts, rowid, key, subject, tags, alt_default, credit)
  VALUES ('delete', old.rowid, old.key, old.subject, old.tags, old.alt_default, old.credit);
  INSERT INTO assets_fts (rowid, key, subject, tags, alt_default, credit)
  VALUES (new.rowid, new.key, new.subject, new.tags, new.alt_default, new.credit);
END;

-- Index the rows that were filed before search existed.
INSERT INTO assets_fts (assets_fts) VALUES ('rebuild');
