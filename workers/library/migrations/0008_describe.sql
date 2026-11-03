-- What a file says about itself, kept: the prep tool now reads the IPTC, XMP
-- and EXIF description and rights fields (title, creator, copyright notice,
-- origin such as "Adobe Stock 270140535") and the uploader seeds the record
-- with them. Every one is editable on the file page and is only ever filled
-- where the row had nothing, so a later upload of the same key cannot write
-- over what staff typed. `origin` rather than `source`: that column already
-- says how the key entered the library ('upload' or 'other').
--
-- A master is the high-resolution or professional-format original (an .ai,
-- .psd, .tif, a raw file) the web copy was made from. `master_url` points at
-- it wherever the team keeps it (Drive, SharePoint, S3, Azure Blob…),
-- `master_name` is its file name so it can be found in any backup, and
-- `master_key` is reserved for a copy kept in the bucket under masters/
-- (a later change). None of these is public: the metadata API never
-- serves them.
--
-- The search index gains the title and the creator, so a creator's name
-- finds every file by them. An FTS5 table's columns are fixed at creation,
-- so the index is made again, as 0006 did, and rebuilt from the rows.

ALTER TABLE assets ADD COLUMN title TEXT;
ALTER TABLE assets ADD COLUMN creator TEXT;
ALTER TABLE assets ADD COLUMN copyright TEXT;
ALTER TABLE assets ADD COLUMN origin TEXT;
ALTER TABLE assets ADD COLUMN master_url TEXT;
ALTER TABLE assets ADD COLUMN master_name TEXT;
ALTER TABLE assets ADD COLUMN master_key TEXT;

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
  title,
  creator,
  content='assets',
  content_rowid='rowid'
);

CREATE TRIGGER assets_fts_ai AFTER INSERT ON assets BEGIN
  INSERT INTO assets_fts (rowid, key, subject, tags, alt_default, credit, camera, lens, title, creator)
  VALUES (new.rowid, new.key, new.subject, new.tags, new.alt_default, new.credit, new.camera, new.lens, new.title, new.creator);
END;

CREATE TRIGGER assets_fts_ad AFTER DELETE ON assets BEGIN
  INSERT INTO assets_fts (assets_fts, rowid, key, subject, tags, alt_default, credit, camera, lens, title, creator)
  VALUES ('delete', old.rowid, old.key, old.subject, old.tags, old.alt_default, old.credit, old.camera, old.lens, old.title, old.creator);
END;

CREATE TRIGGER assets_fts_au AFTER UPDATE OF key, subject, tags, alt_default, credit, camera, lens, title, creator ON assets BEGIN
  INSERT INTO assets_fts (assets_fts, rowid, key, subject, tags, alt_default, credit, camera, lens, title, creator)
  VALUES ('delete', old.rowid, old.key, old.subject, old.tags, old.alt_default, old.credit, old.camera, old.lens, old.title, old.creator);
  INSERT INTO assets_fts (rowid, key, subject, tags, alt_default, credit, camera, lens, title, creator)
  VALUES (new.rowid, new.key, new.subject, new.tags, new.alt_default, new.credit, new.camera, new.lens, new.title, new.creator);
END;

INSERT INTO assets_fts (assets_fts) VALUES ('rebuild');
