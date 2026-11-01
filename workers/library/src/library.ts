/**
 * The media library's metadata and logic. The bucket is the only record of
 * which files exist; `assets` holds what the library knows about a key
 * (subject, tags, default alt text, credit, hashes, source). A key without a
 * row is still listed, as unfiled. Nothing here deletes an object.
 */
import { batchAll, type Db } from './db.js';
import {
  basenameOf,
  IMAGE_KEY,
  type MediaBucket,
  type MediaLayout,
  type MediaObject,
  subjectOf,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_LABEL,
  UPLOAD_SOURCE_TAG,
  uploadKeyPattern,
} from './media.js';

export { IMAGE_KEY };

/** 'upload': came in through the library's Upload page; 'other': found in the bucket. */
export type AssetSource = 'upload' | 'other';

export interface AssetRow {
  key: string;
  etag: string | null;
  sha256: string | null;
  bytes: number | null;
  content_type: string | null;
  width: number | null;
  height: number | null;
  subject: string | null;
  tags: string;
  alt_default: string;
  credit: string | null;
  source: AssetSource;
  first_seen: string;
  uploaded_by: string | null;
  filed_by: string | null;
  filed_at: string | null;
  retired: number;
  retired_note: string | null;
}

export interface Asset extends Omit<AssetRow, 'tags' | 'retired'> {
  tags: string[];
  retired: boolean;
}

const fromRow = (r: AssetRow): Asset => {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(r.tags) as unknown;
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    // a malformed row shows no tags rather than failing the page
  }
  return { ...r, tags, retired: r.retired === 1 };
};

export async function getAsset(db: Db, key: string): Promise<Asset | null> {
  const r = await db.prepare('SELECT * FROM assets WHERE key = ?1').bind(key).first<AssetRow>();
  return r ? fromRow(r) : null;
}

/** Rows for a set of keys, in chunks (SQLite's parameter limit). */
export async function getAssets(db: Db, keys: string[]): Promise<Map<string, Asset>> {
  const out = new Map<string, Asset>();
  for (let i = 0; i < keys.length; i += 90) {
    const chunk = keys.slice(i, i + 90);
    if (chunk.length === 0) continue;
    const marks = chunk.map((_, j) => `?${j + 1}`).join(',');
    const { results } = await db
      .prepare(`SELECT * FROM assets WHERE key IN (${marks})`)
      .bind(...chunk)
      .all<AssetRow>();
    for (const r of results) out.set(r.key, fromRow(r));
  }
  return out;
}

export interface SeenReport {
  /** Keys the library had never recorded. */
  added: number;
  /** Uploads whose record was missing or lacked its hash, completed from the object's own metadata. */
  completed: number;
}

const HASH = /^[0-9a-f]{64}$/;

/**
 * Notes every listed key: a row for each new key, the etag and size refreshed
 * on the rest. An upload stamps the object with its hash, uploader and source
 * before the library row is written, so a row that is missing or has no hash
 * (the request was cut off between the two writes) is completed from the
 * object: hash, uploader, source, and the folder as subject when none was set.
 * Nothing a person set is changed.
 */
export async function noteSeen(
  db: Db,
  layout: MediaLayout,
  objects: MediaObject[],
  now: Date,
): Promise<SeenReport> {
  const images = objects.filter((o) => IMAGE_KEY.test(o.key));
  if (images.length === 0) return { added: 0, completed: 0 };
  const before = await getAssets(
    db,
    images.map((o) => o.key),
  );
  const stamped = images.filter(
    (o) =>
      o.customMetadata?.source === UPLOAD_SOURCE_TAG &&
      HASH.test(o.customMetadata.sha256 ?? '') &&
      !before.get(o.key)?.sha256,
  );
  await batchAll(db, [
    ...images.map((o) =>
      db
        .prepare(
          `INSERT INTO assets (key, etag, bytes, source, first_seen) VALUES (?1, ?2, ?3, 'other', ?4)
           ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, bytes = excluded.bytes`,
        )
        .bind(o.key, o.etag, o.size, now.toISOString()),
    ),
    ...stamped.map((o) =>
      db
        .prepare(
          `UPDATE assets SET sha256 = ?2, source = 'upload',
             uploaded_by = COALESCE(uploaded_by, ?3),
             subject = COALESCE(subject, ?4),
             filed_by = COALESCE(filed_by, ?3), filed_at = COALESCE(filed_at, ?5)
           WHERE key = ?1`,
        )
        .bind(
          o.key,
          o.customMetadata?.sha256 ?? null,
          o.customMetadata?.uploadedBy ?? null,
          subjectOf(layout, o.key),
          now.toISOString(),
        ),
    ),
  ]);
  return {
    added: images.filter((o) => !before.has(o.key)).length,
    completed: stamped.length,
  };
}

export interface UploadRecord {
  key: string;
  sha256: string;
  etag: string | null;
  bytes: number;
  content_type: string;
  width: number | null;
  height: number | null;
  uploaded_by: string;
}

/** An upload made here: filed under its subject at once, hash known, source 'upload'. */
export async function recordUpload(
  db: Db,
  layout: MediaLayout,
  u: UploadRecord,
  now: Date,
): Promise<void> {
  const subject = subjectOf(layout, u.key);
  await db
    .prepare(
      `INSERT INTO assets (key, etag, sha256, bytes, content_type, width, height, subject, source, first_seen, uploaded_by, filed_by, filed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'upload', ?9, ?10, ?10, ?9)
       ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, sha256 = excluded.sha256, bytes = excluded.bytes,
         content_type = excluded.content_type, width = excluded.width, height = excluded.height,
         subject = COALESCE(assets.subject, excluded.subject),
         source = 'upload', uploaded_by = excluded.uploaded_by,
         filed_by = COALESCE(assets.filed_by, excluded.filed_by), filed_at = COALESCE(assets.filed_at, excluded.filed_at)`,
    )
    .bind(
      u.key,
      u.etag,
      u.sha256,
      u.bytes,
      u.content_type,
      u.width,
      u.height,
      subject,
      now.toISOString(),
      u.uploaded_by,
    )
    .run();
}

/** `{name}` is the file name's words, `{subject}` the last subject folder's words. */
export function altFromPattern(layout: MediaLayout, pattern: string, key: string): string {
  const stem = basenameOf(key).replace(/\.[a-z0-9]+$/i, '');
  const words = (s: string) => s.replace(/[-_]+/g, ' ').trim();
  const subject = subjectOf(layout, key);
  return pattern
    .replace(/\{name\}/g, words(stem))
    .replace(/\{subject\}/g, subject ? words(subject.split('/').pop() ?? '') : '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface Filing {
  /** '' clears the subject; undefined leaves it. */
  subject?: string | undefined;
  addTags?: string[] | undefined;
  removeTags?: string[] | undefined;
  /** '' clears the credit; undefined leaves it. */
  credit?: string | undefined;
  /** A pattern for every key ({name}, {subject}); undefined leaves the default alt text. */
  altPattern?: string | undefined;
  /** One literal default alt text (the file page); wins over the pattern. */
  altDefault?: string | undefined;
}

export const parseTags = (text: string): string[] => [
  ...new Set(
    text
      .split(/[,\n]/)
      .map((t) => t.trim().toLowerCase().replace(/\s+/g, '-'))
      .filter(Boolean),
  ),
];

/** Apply one filing to many keys, one D1 batch. Keys without a row get one first. */
export async function fileAssets(
  db: Db,
  layout: MediaLayout,
  keys: string[],
  filing: Filing,
  actor: string,
  now: Date,
): Promise<number> {
  const uniq = [...new Set(keys)].filter((k) => IMAGE_KEY.test(k));
  if (uniq.length === 0) return 0;
  const existing = await getAssets(db, uniq);
  const statements = [];
  for (const key of uniq) {
    const current = existing.get(key);
    const tags = new Set(current?.tags ?? []);
    for (const t of filing.addTags ?? []) tags.add(t);
    for (const t of filing.removeTags ?? []) tags.delete(t);
    const subject =
      filing.subject === undefined ? (current?.subject ?? null) : filing.subject || null;
    const credit = filing.credit === undefined ? (current?.credit ?? null) : filing.credit || null;
    const alt =
      filing.altDefault !== undefined
        ? filing.altDefault
        : filing.altPattern !== undefined && filing.altPattern !== ''
          ? altFromPattern(layout, filing.altPattern, key)
          : (current?.alt_default ?? '');
    const filedNow = subject !== null && (current?.subject ?? null) === null;
    statements.push(
      db
        .prepare(
          `INSERT INTO assets (key, source, first_seen, subject, tags, alt_default, credit, filed_by, filed_at)
           VALUES (?1, 'other', ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT(key) DO UPDATE SET subject = excluded.subject, tags = excluded.tags, alt_default = excluded.alt_default,
             credit = excluded.credit,
             filed_by = CASE WHEN ?9 = 1 THEN excluded.filed_by ELSE assets.filed_by END,
             filed_at = CASE WHEN ?9 = 1 THEN excluded.filed_at ELSE assets.filed_at END`,
        )
        .bind(
          key,
          now.toISOString(),
          subject,
          JSON.stringify([...tags].sort()),
          alt,
          credit,
          subject !== null ? actor : null,
          subject !== null ? now.toISOString() : null,
          filedNow ? 1 : 0,
        ),
    );
  }
  await batchAll(db, statements);
  return uniq.length;
}

export async function retireAsset(
  db: Db,
  key: string,
  note: string | null,
  retired: boolean,
  now: Date,
): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT INTO assets (key, source, first_seen, retired, retired_note) VALUES (?1, 'other', ?2, ?3, ?4)
       ON CONFLICT(key) DO UPDATE SET retired = excluded.retired, retired_note = excluded.retired_note`,
    )
    .bind(key, now.toISOString(), retired ? 1 : 0, retired ? note : null)
    .run();
  return r.meta.changes > 0;
}

/**
 * Forgets a key once its object is gone, so the Unfiled queue and Duplicates
 * stop counting a file that no longer exists.
 */
export async function forgetAsset(db: Db, key: string): Promise<void> {
  await db.prepare('DELETE FROM assets WHERE key = ?1').bind(key).run();
}

export async function listUnfiled(db: Db, limit = 500): Promise<Asset[]> {
  const { results } = await db
    .prepare(
      'SELECT * FROM assets WHERE subject IS NULL AND retired = 0 ORDER BY first_seen DESC, key LIMIT ?1',
    )
    .bind(limit)
    .all<AssetRow>();
  return results.map(fromRow);
}

export async function countUnfiled(db: Db): Promise<number> {
  const r = await db
    .prepare('SELECT COUNT(*) AS n FROM assets WHERE subject IS NULL AND retired = 0')
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export interface DuplicateGroup {
  hash: string;
  assets: Asset[];
}

/** Keys that share a content hash (R2's etag when known, the browser's SHA-256 otherwise). */
export async function listDuplicates(db: Db): Promise<DuplicateGroup[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM assets WHERE retired = 0 AND COALESCE(etag, sha256) IN (
         SELECT COALESCE(etag, sha256) FROM assets WHERE retired = 0 AND COALESCE(etag, sha256) IS NOT NULL
         GROUP BY COALESCE(etag, sha256) HAVING COUNT(*) > 1
       ) ORDER BY COALESCE(etag, sha256), first_seen, key`,
    )
    .all<AssetRow>();
  const groups = new Map<string, Asset[]>();
  for (const r of results) {
    const hash = r.etag ?? r.sha256 ?? '';
    groups.set(hash, [...(groups.get(hash) ?? []), fromRow(r)]);
  }
  return [...groups].map(([hash, assets]) => ({ hash, assets }));
}

export async function countDuplicateKeys(db: Db): Promise<number> {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM assets WHERE retired = 0 AND COALESCE(etag, sha256) IN (
         SELECT COALESCE(etag, sha256) FROM assets WHERE retired = 0 AND COALESCE(etag, sha256) IS NOT NULL
         GROUP BY COALESCE(etag, sha256) HAVING COUNT(*) > 1)`,
    )
    .first<{ n: number }>();
  return r?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Search: the FTS5 index over key, subject, tags, alt text and credit
// ---------------------------------------------------------------------------

/** unfiled and filed are both live rows; retired is its own state whatever the subject. */
export type SearchState = 'all' | 'unfiled' | 'filed' | 'retired';
export const SEARCH_STATES: readonly SearchState[] = ['all', 'unfiled', 'filed', 'retired'];

export interface SearchFilters {
  /** Free text; '' lists everything the filters allow, newest first. */
  q: string;
  subject: string | null;
  tag: string | null;
  state: SearchState;
}

export interface SearchPage {
  assets: Asset[];
  /** Matches across every page. */
  total: number;
}

export interface Facet {
  value: string;
  n: number;
}

export interface SearchFacets {
  subjects: Facet[];
  tags: Facet[];
}

/** Subjects and tags with more than this many values show the most used ones. */
export const FACET_SUBJECTS = 50;
export const FACET_TAGS = 30;

/**
 * The FTS5 query for what a person typed, or null when nothing was typed. Every
 * whitespace-separated piece becomes one quoted phrase, with the last piece a
 * prefix so results appear as a word is typed. Inside a quoted phrase FTS5
 * treats its operators (AND, OR, NOT, NEAR, *, ^, :) as plain text and the
 * tokenizer splits the phrase as it split the indexed text, so nothing a
 * person types can reach the engine as syntax, and `"foo" OR bar*` is simply
 * the words foo, or and bar.
 */
export function ftsQuery(text: string): string | null {
  const phrases = text
    .split(/\s+/)
    .map((piece) => piece.replace(/"/g, ''))
    .filter((piece) => /[\p{L}\p{N}]/u.test(piece))
    .map((piece) => `"${piece}"`);
  if (phrases.length === 0) return null;
  phrases[phrases.length - 1] += '*';
  return phrases.join(' ');
}

interface SearchSql {
  /** The source of rows: `assets`, joined to the index's matches when there is a query. */
  from: string;
  /** The filters, joined with AND; '' when there are none. */
  where: string;
  params: unknown[];
}

/**
 * The FROM and WHERE for a search. With a query, the matched rowids and their
 * bm25 rank come from the index (subject and tags weigh most, then alt text,
 * then the path and credit); the filters then apply to the joined rows. A
 * facet leaves its own filter out, so the list offers the other values.
 */
function searchSql(f: SearchFilters, omit: 'subject' | 'tag' | null = null): SearchSql {
  const params: unknown[] = [];
  const bind = (v: unknown) => {
    params.push(v);
    return `?${params.length}`;
  };
  const match = ftsQuery(f.q);
  const from = match
    ? `assets a JOIN (SELECT rowid, bm25(assets_fts, 1.0, 3.0, 3.0, 2.0, 1.0) AS rank
         FROM assets_fts WHERE assets_fts MATCH ${bind(match)}) m ON m.rowid = a.rowid`
    : 'assets a';
  const clauses: string[] = [];
  if (f.subject !== null && omit !== 'subject') clauses.push(`a.subject = ${bind(f.subject)}`);
  if (f.tag !== null && omit !== 'tag')
    clauses.push(`EXISTS (SELECT 1 FROM json_each(a.tags) WHERE value = ${bind(f.tag)})`);
  if (f.state === 'unfiled') clauses.push('a.subject IS NULL AND a.retired = 0');
  else if (f.state === 'filed') clauses.push('a.subject IS NOT NULL AND a.retired = 0');
  else if (f.state === 'retired') clauses.push('a.retired = 1');
  return { from, where: clauses.join(' AND '), params };
}

const whereOf = (...clauses: string[]) => {
  const live = clauses.filter(Boolean);
  return live.length ? ` WHERE ${live.join(' AND ')}` : '';
};

/** Matches by relevance when there is a query, newest first otherwise. Only keys the library knows. */
export async function searchAssets(
  db: Db,
  filters: SearchFilters,
  limit: number,
  offset = 0,
): Promise<SearchPage> {
  const s = searchSql(filters);
  const order = ftsQuery(filters.q)
    ? 'ORDER BY m.rank, a.first_seen DESC, a.key'
    : 'ORDER BY a.first_seen DESC, a.key';
  const n = s.params.length;
  const [{ results }, count] = await Promise.all([
    db
      .prepare(
        `SELECT a.* FROM ${s.from}${whereOf(s.where)} ${order} LIMIT ?${n + 1} OFFSET ?${n + 2}`,
      )
      .bind(...s.params, limit, offset)
      .all<AssetRow>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM ${s.from}${whereOf(s.where)}`)
      .bind(...s.params)
      .first<{ n: number }>(),
  ]);
  return { assets: results.map(fromRow), total: count?.n ?? 0 };
}

/** The subjects and tags among the matches, most used first, each counted without its own filter. */
export async function searchFacets(db: Db, filters: SearchFilters): Promise<SearchFacets> {
  const bySubject = searchSql(filters, 'subject');
  const byTag = searchSql(filters, 'tag');
  const [subjects, tags] = await Promise.all([
    db
      .prepare(
        `SELECT a.subject AS value, COUNT(*) AS n FROM ${bySubject.from}${whereOf(
          bySubject.where,
          'a.subject IS NOT NULL',
        )} GROUP BY a.subject ORDER BY n DESC, value LIMIT ?${bySubject.params.length + 1}`,
      )
      .bind(...bySubject.params, FACET_SUBJECTS)
      .all<Facet>(),
    db
      .prepare(
        `SELECT j.value AS value, COUNT(*) AS n FROM ${byTag.from}, json_each(a.tags) j${whereOf(
          byTag.where,
        )} GROUP BY j.value ORDER BY n DESC, value LIMIT ?${byTag.params.length + 1}`,
      )
      .bind(...byTag.params, FACET_TAGS)
      .all<Facet>(),
  ]);
  return { subjects: subjects.results, tags: tags.results };
}

// ---------------------------------------------------------------------------
// Precheck: what the browser asks before it sends bytes
// ---------------------------------------------------------------------------

export interface PrecheckEntry {
  key: string;
  sha256: string;
  size: number;
}

export type PrecheckStatus =
  | 'ok'
  | 'duplicate'
  | 'same-file'
  | 'name-taken'
  | 'bad-name'
  | 'too-big';

export interface PrecheckAnswer {
  key: string;
  status: PrecheckStatus;
  /** For duplicate: the key the same bytes already live at. */
  existingKey?: string;
  message: string;
}

/** The resizer cannot take a larger source, so the store never holds one. */
export const TOO_BIG = `Over ${UPLOAD_MAX_LABEL}, the resizer's input cap: prepare it first with tools/prep-images.py.`;

export async function precheck(
  db: Db,
  bucket: MediaBucket,
  layout: MediaLayout,
  entries: PrecheckEntry[],
): Promise<PrecheckAnswer[]> {
  const pattern = uploadKeyPattern(layout);
  const seenHashes = new Map<string, string>();
  const answers: PrecheckAnswer[] = [];
  const valid = entries.filter((e) => HASH.test(e.sha256));
  const byHash = new Map<string, Asset>();
  for (let i = 0; i < valid.length; i += 90) {
    const chunk = valid.slice(i, i + 90);
    if (chunk.length === 0) continue;
    const marks = chunk.map((_, j) => `?${j + 1}`).join(',');
    const { results } = await db
      .prepare(`SELECT * FROM assets WHERE retired = 0 AND sha256 IN (${marks})`)
      .bind(...chunk.map((e) => e.sha256))
      .all<AssetRow>();
    for (const r of results)
      if (r.sha256 && !byHash.has(r.sha256)) byHash.set(r.sha256, fromRow(r));
  }
  // A row whose object is gone (deleted outside the library) must not call the next
  // upload a duplicate: check the store once per known key and forget the strays.
  for (const [hash, a] of [...byHash]) {
    if (!(await bucket.head(a.key))) {
      byHash.delete(hash);
      await forgetAsset(db, a.key);
    }
  }
  for (const e of entries) {
    if (!HASH.test(e.sha256)) {
      answers.push({ key: e.key, status: 'bad-name', message: 'No content hash was sent.' });
      continue;
    }
    if (!pattern.test(e.key)) {
      answers.push({
        key: e.key,
        status: 'bad-name',
        message: `Keys are ${layout.uploadPrefix}<subject>/<name>.<ext> (jpg, png, webp, avif, gif), lowercase letters, digits and hyphens.`,
      });
      continue;
    }
    if (e.size > UPLOAD_MAX_BYTES) {
      answers.push({ key: e.key, status: 'too-big', message: TOO_BIG });
      continue;
    }
    const known = byHash.get(e.sha256);
    if (known && known.key === e.key) {
      answers.push({
        key: e.key,
        status: 'same-file',
        message: 'Already in the store at this key.',
      });
      continue;
    }
    const dupKey = known?.key ?? seenHashes.get(e.sha256);
    if (dupKey) {
      answers.push({
        key: e.key,
        status: 'duplicate',
        existingKey: dupKey,
        message: `The same image is already at ${dupKey}.`,
      });
      continue;
    }
    const taken = await bucket.head(e.key);
    if (taken) {
      if (taken.customMetadata?.sha256 === e.sha256) {
        // The same bytes are at the key but the library has no record of them: a first
        // attempt was cut off after the store took the file. The PUT completes the record.
        seenHashes.set(e.sha256, e.key);
        answers.push({
          key: e.key,
          status: 'ok',
          message: 'Already in the store; the upload will complete its record.',
        });
        continue;
      }
      answers.push({
        key: e.key,
        status: 'name-taken',
        message: 'A different file already has this name. Rename it; keys are never overwritten.',
      });
      continue;
    }
    seenHashes.set(e.sha256, e.key);
    answers.push({ key: e.key, status: 'ok', message: 'Ready to upload.' });
  }
  return answers;
}

// ---------------------------------------------------------------------------
// Rescan: walk the bucket, refresh what the library knows
// ---------------------------------------------------------------------------

export interface RescanReport {
  listed: number;
  added: number;
  /** Upload records completed from the objects' own metadata. */
  completed: number;
  /** Rows forgotten because their object is no longer in the store. */
  forgotten: number;
}

export async function rescan(
  db: Db,
  bucket: MediaBucket,
  layout: MediaLayout,
  now: Date,
): Promise<RescanReport> {
  let listed = 0;
  let added = 0;
  let completed = 0;
  const present = new Set<string>();
  for (const prefix of layout.libraryPrefixes) {
    let cursor: string | undefined;
    do {
      const page = await bucket.list(prefix, { limit: 1000, ...(cursor ? { cursor } : {}) });
      listed += page.objects.length;
      for (const o of page.objects) present.add(o.key);
      const seen = await noteSeen(db, layout, page.objects, now);
      added += seen.added;
      completed += seen.completed;
      cursor = page.cursor ?? undefined;
    } while (cursor);
  }
  // The bucket is the record of what exists: a row whose object is gone, under a
  // listed root or under a prefix the library no longer lists, is forgotten.
  const { results: rows } = await db.prepare('SELECT key FROM assets').all<{ key: string }>();
  const gone = rows.map((r) => r.key).filter((k) => !present.has(k));
  for (let i = 0; i < gone.length; i += 90) {
    const chunk = gone.slice(i, i + 90);
    const marks = chunk.map((_, j) => `?${j + 1}`).join(',');
    await db
      .prepare(`DELETE FROM assets WHERE key IN (${marks})`)
      .bind(...chunk)
      .run();
  }
  // The search index is external-content: it trusts the triggers to have kept it in
  // step. A walk of the whole bucket is the moment to make that true from scratch.
  await db.prepare("INSERT INTO assets_fts (assets_fts) VALUES ('rebuild')").run();
  return { listed, added, completed, forgotten: gone.length };
}
