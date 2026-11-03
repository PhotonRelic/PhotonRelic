/**
 * The media library's metadata and logic. The bucket is the only record of
 * which files exist; `assets` holds what the library knows about a key
 * (subject, tags, default alt text, credit, rights, hashes, source). A key
 * without a row is still listed, as unfiled. Nothing here deletes an object.
 */
import { auditStatement } from './audit.js';
import { batchAll, type Db } from './db.js';
import {
  basenameOf,
  IMAGE_KEY,
  isLibraryKey,
  type MediaBucket,
  type MediaLayout,
  type MediaObject,
  subjectOf,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_LABEL,
  UPLOAD_SOURCE_TAG,
  uploadKeyPattern,
  WEB_IMAGE_KEY,
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
  /**
   * What the file said about itself (IPTC, XMP, EXIF), seeded by an upload
   * and editable since: a title, who made it, the copyright notice, and where
   * it came from ("Adobe Stock 270140535"). `origin`, not `source`: that
   * column says how the key entered the library.
   */
  title: string | null;
  creator: string | null;
  copyright: string | null;
  origin: string | null;
  /** Rights: free text, an http(s) URL, free text, and a date (YYYY-MM-DD); all optional. */
  license: string | null;
  source_url: string | null;
  restrictions: string | null;
  expires_at: string | null;
  /**
   * The master this web copy was made from: a link to wherever the team keeps
   * it (any URL scheme), its file name, and, reserved for a copy held in the
   * bucket under masters/, its key. Never served by the metadata API.
   */
  master_url: string | null;
  master_name: string | null;
  master_key: string | null;
  source: AssetSource;
  first_seen: string;
  uploaded_by: string | null;
  filed_by: string | null;
  filed_at: string | null;
  retired: number;
  retired_note: string | null;
  /** From the upload's capture entry (manifest or browser EXIF); null for everything else. */
  captured_at: string | null;
  camera: string | null;
  lens: string | null;
  original_width: number | null;
  original_height: number | null;
  /** Where a cover crop keeps its subject, as fractions of the width and height; both null = automatic. */
  focal_x: number | null;
  focal_y: number | null;
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
  /** Keys whose object no longer has the etag the library recorded: the bytes were replaced outside. */
  changed: string[];
}

const HASH = /^[0-9a-f]{64}$/;

/**
 * Notes every listed key: a row for each new key, the etag and size refreshed
 * on the rest. An upload stamps the object with its hash, uploader and source
 * before the library row is written, so a row that is missing or has no hash
 * (the request was cut off between the two writes) is completed from the
 * object: hash, uploader, source, and the folder as subject when none was set.
 * A key whose etag no longer matches holds different bytes (rclone, the
 * dashboard, a Replace that was cut off): its hash and dimensions are no
 * longer known and are cleared, unless the object carries its own stamp.
 * Nothing a person set is changed.
 */
export async function noteSeen(
  db: Db,
  layout: MediaLayout,
  objects: MediaObject[],
  now: Date,
): Promise<SeenReport> {
  const images = objects.filter((o) => IMAGE_KEY.test(o.key));
  if (images.length === 0) return { added: 0, completed: 0, changed: [] };
  const before = await getAssets(
    db,
    images.map((o) => o.key),
  );
  const changed = images.filter((o) => {
    const row = before.get(o.key);
    return Boolean(row?.etag && o.etag && row.etag !== o.etag);
  });
  const changedKeys = new Set(changed.map((o) => o.key));
  const stamped = images.filter(
    (o) =>
      o.customMetadata?.source === UPLOAD_SOURCE_TAG &&
      HASH.test(o.customMetadata.sha256 ?? '') &&
      (!before.get(o.key)?.sha256 || changedKeys.has(o.key)),
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
    ...changed.map((o) =>
      db
        .prepare('UPDATE assets SET sha256 = NULL, width = NULL, height = NULL WHERE key = ?1')
        .bind(o.key),
    ),
    ...stamped.map((o) =>
      db
        .prepare(
          `UPDATE assets SET sha256 = ?2, source = 'upload',
             uploaded_by = CASE WHEN ?6 = 1 THEN ?3 ELSE COALESCE(uploaded_by, ?3) END,
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
          changedKeys.has(o.key) ? 1 : 0,
        ),
    ),
  ]);
  return {
    added: images.filter((o) => !before.has(o.key)).length,
    completed: stamped.length,
    changed: changed.map((o) => o.key),
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
  /** What the browser knew about the original; absent when it sent nothing. */
  capture?: Capture | null | undefined;
  /** What the file said about itself, from the manifest or its own tags; absent when nothing was sent. */
  describe?: Describe | null | undefined;
}

/**
 * An upload made here: filed under its subject at once, hash known, source
 * 'upload'. A retry that sends no capture entry keeps the one already recorded:
 * the browser only reads EXIF once per file, and the record must not lose it
 * to a second attempt. The describe entry seeds the editable fields and only
 * where the row has nothing: a title, tags, alt text or credit staff typed is
 * never written over by a later upload of the same key.
 */
export async function recordUpload(
  db: Db,
  layout: MediaLayout,
  u: UploadRecord,
  now: Date,
): Promise<void> {
  const subject = subjectOf(layout, u.key);
  const cap = u.capture ?? {};
  const d = u.describe ?? {};
  await db
    .prepare(
      `INSERT INTO assets (key, etag, sha256, bytes, content_type, width, height, subject, source, first_seen, uploaded_by, filed_by, filed_at,
                           captured_at, camera, lens, original_width, original_height,
                           tags, alt_default, credit, title, creator, copyright, origin, source_url, restrictions, master_name, license)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'upload', ?9, ?10, ?10, ?9, ?11, ?12, ?13, ?14, ?15,
               ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)
       ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, sha256 = excluded.sha256, bytes = excluded.bytes,
         content_type = excluded.content_type, width = excluded.width, height = excluded.height,
         subject = COALESCE(assets.subject, excluded.subject),
         source = 'upload', uploaded_by = excluded.uploaded_by,
         filed_by = COALESCE(assets.filed_by, excluded.filed_by), filed_at = COALESCE(assets.filed_at, excluded.filed_at),
         captured_at = COALESCE(excluded.captured_at, assets.captured_at),
         camera = COALESCE(excluded.camera, assets.camera),
         lens = COALESCE(excluded.lens, assets.lens),
         original_width = COALESCE(excluded.original_width, assets.original_width),
         original_height = COALESCE(excluded.original_height, assets.original_height),
         tags = CASE WHEN assets.tags = '[]' THEN excluded.tags ELSE assets.tags END,
         alt_default = CASE WHEN assets.alt_default = '' THEN excluded.alt_default ELSE assets.alt_default END,
         credit = COALESCE(assets.credit, excluded.credit),
         title = COALESCE(assets.title, excluded.title),
         creator = COALESCE(assets.creator, excluded.creator),
         copyright = COALESCE(assets.copyright, excluded.copyright),
         origin = COALESCE(assets.origin, excluded.origin),
         source_url = COALESCE(assets.source_url, excluded.source_url),
         restrictions = COALESCE(assets.restrictions, excluded.restrictions),
         master_name = COALESCE(assets.master_name, excluded.master_name),
         license = COALESCE(assets.license, excluded.license)`,
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
      cap.capturedAt ?? null,
      cap.camera ?? null,
      cap.lens ?? null,
      cap.originalWidth ?? null,
      cap.originalHeight ?? null,
      JSON.stringify([...(d.keywords ?? [])].sort()),
      d.description ?? '',
      d.credit ?? null,
      d.title ?? null,
      d.creator ?? null,
      d.copyright ?? null,
      d.origin ?? null,
      d.sourceUrl ?? null,
      d.usageTerms ?? null,
      d.masterName ?? null,
      d.license ?? null,
    )
    .run();
}

// ---------------------------------------------------------------------------
// Capture: what the browser knew about the original
// ---------------------------------------------------------------------------

/**
 * One file's entry from the prep tool's manifest, or what the browser read from
 * the file's own EXIF. Only these fields exist: there is no GPS, serial number
 * or owner name here because neither reader looks for them.
 */
export interface Capture {
  /** ISO 8601 as the camera wrote it; no timezone unless the camera gave one. */
  capturedAt?: string;
  camera?: string;
  lens?: string;
  originalWidth?: number;
  originalHeight?: number;
}

/** The longest `X-Capture` header the server will read; the fields fit in a tenth of it. */
export const CAPTURE_HEADER_MAX = 2048;
const CAPTURE_TEXT_MAX = 120;
const CAPTURE_PIXELS_MAX = 1_000_000;
// A date, optionally a time to the second or millisecond, optionally an offset or Z.
const CAPTURED_AT =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const hasControl = (s: string) =>
  [...s].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);

export interface ParsedCapture {
  /** Null when nothing usable was sent. */
  capture: Capture | null;
  /** Why a field, or the whole header, was dropped; empty when it was all taken. */
  problems: string[];
}

/**
 * The `X-Capture` header: percent-encoded JSON, so a camera name with a space
 * or a non-ASCII letter travels in a header safely. The upload never fails on
 * it: a header that cannot be read is dropped and said so; a field that fails
 * its check is dropped on its own; keys this version does not know are
 * ignored, so an older server takes a newer browser's entry.
 */
export function parseCaptureHeader(raw: string | undefined): ParsedCapture {
  if (raw === undefined || raw === '') return { capture: null, problems: [] };
  if (raw.length > CAPTURE_HEADER_MAX)
    return { capture: null, problems: [`X-Capture is over ${CAPTURE_HEADER_MAX} characters.`] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    return { capture: null, problems: ['X-Capture is not percent-encoded JSON.'] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return { capture: null, problems: ['X-Capture is not a JSON object.'] };
  const o = parsed as Record<string, unknown>;
  const problems: string[] = [];
  const capture: Capture = {};
  const text = (k: 'camera' | 'lens') => {
    const v = o[k];
    if (v === undefined || v === null) return;
    const s = typeof v === 'string' ? v.trim() : '';
    if (s === '' || s.length > CAPTURE_TEXT_MAX || hasControl(s)) {
      problems.push(`${k}: not a short line of text.`);
      return;
    }
    capture[k] = s;
  };
  const pixels = (k: 'originalWidth' | 'originalHeight') => {
    const v = o[k];
    if (v === undefined || v === null) return;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > CAPTURE_PIXELS_MAX) {
      problems.push(`${k}: not a whole number of pixels.`);
      return;
    }
    capture[k] = v;
  };
  if (o.capturedAt !== undefined && o.capturedAt !== null) {
    const s = typeof o.capturedAt === 'string' ? o.capturedAt.trim() : '';
    if (CAPTURED_AT.test(s)) capture.capturedAt = s;
    else problems.push('capturedAt: not an ISO 8601 date.');
  }
  text('camera');
  text('lens');
  pixels('originalWidth');
  pixels('originalHeight');
  // A width without a height says nothing about the original's size.
  if ((capture.originalWidth === undefined) !== (capture.originalHeight === undefined)) {
    delete capture.originalWidth;
    delete capture.originalHeight;
    problems.push('originalWidth and originalHeight go together.');
  }
  return { capture: Object.keys(capture).length ? capture : null, problems };
}

// ---------------------------------------------------------------------------
// Describe: what the file said about itself
// ---------------------------------------------------------------------------

/**
 * One file's describe entry from the prep tool's manifest: the description
 * and rights fields it read from the file's IPTC, XMP and EXIF, and the name
 * of the master it found beside the file. Every one seeds an editable field.
 */
export interface Describe {
  title?: string;
  description?: string;
  keywords?: string[];
  creator?: string;
  credit?: string;
  copyright?: string;
  origin?: string;
  sourceUrl?: string;
  usageTerms?: string;
  /** The license bought, as the prep tool recorded it for a stock file. */
  license?: string;
  masterName?: string;
}

/** The longest `X-Describe` header the server will read: fifty keywords and a caption fit easily. */
export const DESCRIBE_HEADER_MAX = 8192;
export const DESCRIBE_MAX = {
  title: 300,
  description: 1000,
  creator: 200,
  credit: 200,
  copyright: 200,
  origin: 200,
  sourceUrl: 2048,
  usageTerms: 2000,
  license: 200,
  masterName: 200,
  keywords: 100,
  keyword: 60,
} as const;

export interface ParsedDescribe {
  describe: Describe | null;
  problems: string[];
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
/** Control characters other than a line break: a restrictions text may have lines. */
const hasControlButNewline = (s: string) =>
  [...s].some((ch) => {
    const c = ch.charCodeAt(0);
    return (c < 32 && c !== 10 && c !== 13) || c === 127;
  });

/**
 * The `X-Describe` header, percent-encoded JSON like `X-Capture`, and read
 * the same way: a header that cannot be read is dropped and said so, a field
 * that fails its check is dropped on its own, unknown keys are ignored.
 * Keywords go through `parseTags`, so a manifest's keywords obey the rules
 * typed tags do. A source URL must be http(s), as the Rights form requires.
 */
export function parseDescribeHeader(raw: string | undefined): ParsedDescribe {
  if (raw === undefined || raw === '') return { describe: null, problems: [] };
  if (raw.length > DESCRIBE_HEADER_MAX)
    return { describe: null, problems: [`X-Describe is over ${DESCRIBE_HEADER_MAX} characters.`] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    return { describe: null, problems: ['X-Describe is not percent-encoded JSON.'] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return { describe: null, problems: ['X-Describe is not a JSON object.'] };
  const o = parsed as Record<string, unknown>;
  const problems: string[] = [];
  const describe: Describe = {};
  const text = (k: Exclude<keyof Describe, 'keywords'>, max: number, keepLines = false) => {
    const v = o[k];
    if (v === undefined || v === null) return;
    const s = typeof v === 'string' ? (keepLines ? v.trim() : oneLine(v)) : '';
    if (s === '' || s.length > max || (keepLines ? hasControlButNewline(s) : hasControl(s))) {
      problems.push(`${k}: not text under ${max} characters.`);
      return;
    }
    describe[k] = s;
  };
  text('title', DESCRIBE_MAX.title);
  text('description', DESCRIBE_MAX.description);
  text('creator', DESCRIBE_MAX.creator);
  text('credit', DESCRIBE_MAX.credit);
  text('copyright', DESCRIBE_MAX.copyright);
  text('origin', DESCRIBE_MAX.origin);
  text('masterName', DESCRIBE_MAX.masterName);
  text('license', DESCRIBE_MAX.license);
  text('usageTerms', DESCRIBE_MAX.usageTerms, true);
  text('sourceUrl', DESCRIBE_MAX.sourceUrl);
  if (describe.sourceUrl !== undefined) {
    let protocol = '';
    try {
      protocol = new URL(describe.sourceUrl).protocol;
    } catch {
      // not a URL; refused below
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      delete describe.sourceUrl;
      problems.push('sourceUrl: not an http(s) URL.');
    }
  }
  if (o.keywords !== undefined && o.keywords !== null) {
    if (!Array.isArray(o.keywords) || !o.keywords.every((k) => typeof k === 'string')) {
      problems.push('keywords: not a list of words.');
    } else {
      const words = parseTags(o.keywords.filter((k) => !hasControl(k)).join(','))
        .filter((t) => t.length <= DESCRIBE_MAX.keyword)
        .slice(0, DESCRIBE_MAX.keywords);
      if (words.length) describe.keywords = words;
    }
  }
  return { describe: Object.keys(describe).length ? describe : null, problems };
}

/**
 * New bytes under an existing key, through the file page's Replace. The row
 * keeps everything a person set (subject, tags, alt text, credit, the retired
 * state) and its first_seen; what describes the bytes is replaced, and what
 * described the old bytes alone is forgotten: the capture data belonged to the
 * old file, and a focal point chosen on the old picture would crop the new
 * one blindly. A key with no row yet is recorded as an upload would be.
 */
export async function recordReplace(
  db: Db,
  layout: MediaLayout,
  u: UploadRecord,
  now: Date,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO assets (key, etag, sha256, bytes, content_type, width, height, subject, source, first_seen, uploaded_by, filed_by, filed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'upload', ?9, ?10, ?10, ?9)
       ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, sha256 = excluded.sha256, bytes = excluded.bytes,
         content_type = excluded.content_type, width = excluded.width, height = excluded.height,
         source = 'upload', uploaded_by = excluded.uploaded_by,
         captured_at = NULL, camera = NULL, lens = NULL, original_width = NULL, original_height = NULL,
         focal_x = NULL, focal_y = NULL`,
    )
    .bind(
      u.key,
      u.etag,
      u.sha256,
      u.bytes,
      u.content_type,
      u.width,
      u.height,
      subjectOf(layout, u.key),
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
  /** The file page's title; '' clears it, undefined leaves it. */
  title?: string | undefined;
  /** Rights, already validated (see `checkRights`); '' clears each, undefined leaves it. */
  license?: string | undefined;
  sourceUrl?: string | undefined;
  restrictions?: string | undefined;
  expiresAt?: string | undefined;
  creator?: string | undefined;
  copyright?: string | undefined;
  origin?: string | undefined;
  masterUrl?: string | undefined;
  masterName?: string | undefined;
  /**
   * A folder every selected file's master sits in: each key whose master name
   * is recorded gets `masterBase/<name>` as its master URL, the others are left
   * alone (a Drive folder link takes no file name, so the record then says
   * "in this folder, named this"). Wins over `masterUrl`.
   */
  masterBase?: string | undefined;
}

/** `base/<name>`: one slash between, the name percent-encoded as a path segment. */
export const masterUrlIn = (base: string, name: string): string =>
  `${base.replace(/\/+$/, '')}/${encodeURIComponent(name)}`;

// ---------------------------------------------------------------------------
// Rights: license, source, restrictions and expiry
// ---------------------------------------------------------------------------

export interface Rights {
  license: string;
  sourceUrl: string;
  restrictions: string;
  expiresAt: string;
  creator: string;
  copyright: string;
  origin: string;
  masterUrl: string;
  masterName: string;
}

/** Bounds on the free-text fields, so a pasted contract does not become a row. */
export const RIGHTS_MAX = {
  license: 200,
  sourceUrl: 2048,
  restrictions: 2000,
  creator: 200,
  copyright: 200,
  origin: 200,
  masterUrl: 2048,
  masterName: 200,
  title: 300,
} as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date as YYYY-MM-DD: the shape, and a day that exists. */
export function isIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** The UTC calendar date of an instant, the form `expires_at` is compared against. */
export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export function plusDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

/**
 * Validates what a form sent for the rights fields. Each may be blank; a
 * source URL must be http(s), a master URL any URL with a scheme (s3://,
 * azure:// and the like open in the team's own tools), an expiry a real date,
 * and the texts bounded. The first problem is returned as a message for the
 * flash.
 */
export function checkRights(
  raw: Partial<Rights>,
): { ok: true; rights: Rights } | { ok: false; error: string } {
  const license = (raw.license ?? '').trim();
  const sourceUrl = (raw.sourceUrl ?? '').trim();
  const restrictions = (raw.restrictions ?? '').trim();
  const expiresAt = (raw.expiresAt ?? '').trim();
  const creator = oneLine(raw.creator ?? '');
  const copyright = oneLine(raw.copyright ?? '');
  const origin = oneLine(raw.origin ?? '');
  const masterUrl = (raw.masterUrl ?? '').trim();
  const masterName = oneLine(raw.masterName ?? '');
  if (license.length > RIGHTS_MAX.license)
    return { ok: false, error: `License: at most ${RIGHTS_MAX.license} characters.` };
  if (creator.length > RIGHTS_MAX.creator)
    return { ok: false, error: `Creator: at most ${RIGHTS_MAX.creator} characters.` };
  if (copyright.length > RIGHTS_MAX.copyright)
    return { ok: false, error: `Copyright: at most ${RIGHTS_MAX.copyright} characters.` };
  if (origin.length > RIGHTS_MAX.origin)
    return { ok: false, error: `Origin: at most ${RIGHTS_MAX.origin} characters.` };
  if (masterName.length > RIGHTS_MAX.masterName)
    return { ok: false, error: `Master name: at most ${RIGHTS_MAX.masterName} characters.` };
  if (masterUrl.length > RIGHTS_MAX.masterUrl)
    return { ok: false, error: `Master URL: at most ${RIGHTS_MAX.masterUrl} characters.` };
  if (masterUrl !== '' && !isMasterUrl(masterUrl))
    return { ok: false, error: 'Master URL must be a link with a scheme, like https:// or s3://.' };
  if (sourceUrl.length > RIGHTS_MAX.sourceUrl)
    return { ok: false, error: `Source URL: at most ${RIGHTS_MAX.sourceUrl} characters.` };
  if (sourceUrl !== '') {
    let protocol = '';
    try {
      protocol = new URL(sourceUrl).protocol;
    } catch {
      // not a URL at all; refused below
    }
    if (protocol !== 'http:' && protocol !== 'https:')
      return { ok: false, error: 'Source URL must start with http:// or https://.' };
  }
  if (restrictions.length > RIGHTS_MAX.restrictions)
    return { ok: false, error: `Restrictions: at most ${RIGHTS_MAX.restrictions} characters.` };
  if (expiresAt !== '' && !isIsoDate(expiresAt))
    return { ok: false, error: 'Expires: a date as YYYY-MM-DD.' };
  return {
    ok: true,
    rights: {
      license,
      sourceUrl,
      restrictions,
      expiresAt,
      creator,
      copyright,
      origin,
      masterUrl,
      masterName,
    },
  };
}

/**
 * A master link: any URL with a scheme and something after it, and no control
 * characters. A space in the path is allowed, since SharePoint's "Shared
 * Documents" has one; the browser encodes it on the way out.
 */
export function isMasterUrl(s: string): boolean {
  if (hasControl(s)) return false;
  try {
    const u = new URL(s);
    return u.protocol.length > 1 && s.length > u.protocol.length + 1;
  } catch {
    return false;
  }
}

/** Where a master link points, judged by its host or scheme, for a glyph and a label. */
export interface MasterProvider {
  /** A short code for the glyph: letters, never a vendor's mark. */
  code: string;
  label: string;
}

export function masterProvider(url: string): MasterProvider {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { code: 'URL', label: 'Link' };
  }
  const host = u.hostname.toLowerCase();
  const scheme = u.protocol.replace(/:$/, '');
  const on = (...hosts: string[]) =>
    hosts.some((h) => (h.startsWith('.') ? host.endsWith(h) : host === h));
  if (on('drive.google.com', 'docs.google.com')) return { code: 'GD', label: 'Google Drive' };
  if (on('.sharepoint.com', '.sharepoint.us')) return { code: 'SP', label: 'SharePoint' };
  if (on('onedrive.live.com', '1drv.ms', '.sharepoint-df.com'))
    return { code: 'OD', label: 'OneDrive' };
  if (scheme === 's3' || on('.amazonaws.com')) return { code: 'S3', label: 'Amazon S3' };
  if (scheme === 'azure' || scheme === 'wasb' || scheme === 'wasbs' || on('.blob.core.windows.net'))
    return { code: 'AZ', label: 'Azure Blob' };
  if (on('dropbox.com', '.dropbox.com', 'dropboxusercontent.com'))
    return { code: 'DB', label: 'Dropbox' };
  if (on('box.com', '.box.com')) return { code: 'BX', label: 'Box' };
  if (scheme === 'file' || scheme === 'smb' || scheme === 'afp')
    return { code: 'NAS', label: 'Network share' };
  return { code: 'URL', label: host || scheme };
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
    // Each rights field: undefined leaves what is there, '' clears it.
    const keep = (next: string | undefined, had: string | null | undefined) =>
      next === undefined ? (had ?? null) : next || null;
    statements.push(
      db
        .prepare(
          `INSERT INTO assets (key, source, first_seen, subject, tags, alt_default, credit, filed_by, filed_at,
             license, source_url, restrictions, expires_at, title, creator, copyright, origin, master_url, master_name)
           VALUES (?1, 'other', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
           ON CONFLICT(key) DO UPDATE SET subject = excluded.subject, tags = excluded.tags, alt_default = excluded.alt_default,
             credit = excluded.credit,
             filed_by = CASE WHEN ?9 = 1 THEN excluded.filed_by ELSE assets.filed_by END,
             filed_at = CASE WHEN ?9 = 1 THEN excluded.filed_at ELSE assets.filed_at END,
             license = excluded.license, source_url = excluded.source_url,
             restrictions = excluded.restrictions, expires_at = excluded.expires_at,
             title = excluded.title, creator = excluded.creator, copyright = excluded.copyright,
             origin = excluded.origin, master_url = excluded.master_url, master_name = excluded.master_name`,
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
          keep(filing.license, current?.license),
          keep(filing.sourceUrl, current?.source_url),
          keep(filing.restrictions, current?.restrictions),
          keep(filing.expiresAt, current?.expires_at),
          keep(filing.title, current?.title),
          keep(filing.creator, current?.creator),
          keep(filing.copyright, current?.copyright),
          keep(filing.origin, current?.origin),
          filing.masterBase !== undefined && current?.master_name
            ? masterUrlIn(filing.masterBase, current.master_name)
            : keep(filing.masterUrl, current?.master_url),
          keep(filing.masterName, current?.master_name),
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

// ---------------------------------------------------------------------------
// Focal point: where a cover crop keeps its subject
// ---------------------------------------------------------------------------

/** A point in the image as fractions of its width and height, 0 to 1 from the top-left. */
export interface Focal {
  x: number;
  y: number;
}

export type FocalParse = { ok: true; focal: Focal | null } | { ok: false; message: string };

/** A fraction as the file page posts it: 0 to 1 inclusive, at most four decimals. */
const FRACTION = /^[01](?:\.\d{1,4})?$/;

/**
 * The two fields of the focal form. Both empty is the Automatic button:
 * the point is cleared. Four decimals is finer than any crop can show and
 * keeps the stored value exactly what the page displayed.
 */
export function parseFocal(x: string, y: string): FocalParse {
  const xs = x.trim();
  const ys = y.trim();
  if (xs === '' && ys === '') return { ok: true, focal: null };
  if (xs === '' || ys === '') return { ok: false, message: 'A focal point needs both x and y.' };
  const nx = Number(xs);
  const ny = Number(ys);
  if (!FRACTION.test(xs) || !FRACTION.test(ys) || nx > 1 || ny > 1)
    return {
      ok: false,
      message: 'x and y must be fractions from 0 to 1 with up to four decimals.',
    };
  return { ok: true, focal: { x: nx, y: ny } };
}

/** The focal point a row holds, or null when either half is missing. */
export const focalOf = (asset: Asset | null): Focal | null =>
  asset && asset.focal_x !== null && asset.focal_y !== null
    ? { x: asset.focal_x, y: asset.focal_y }
    : null;

/** Set or clear (null) a key's focal point. A key without a row gets one first, as unfiled. */
export async function setFocal(db: Db, key: string, focal: Focal | null, now: Date): Promise<void> {
  await db
    .prepare(
      `INSERT INTO assets (key, source, first_seen, focal_x, focal_y) VALUES (?1, 'other', ?2, ?3, ?4)
       ON CONFLICT(key) DO UPDATE SET focal_x = excluded.focal_x, focal_y = excluded.focal_y`,
    )
    .bind(key, now.toISOString(), focal?.x ?? null, focal?.y ?? null)
    .run();
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

/** Every key the library knows and has not retired, oldest first: the candidates for "unused". */
export async function listActive(db: Db): Promise<Asset[]> {
  const { results } = await db
    .prepare('SELECT * FROM assets WHERE retired = 0 ORDER BY first_seen, key')
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
// Search: the FTS5 index over key, subject, tags, alt text, credit, camera, lens, title and creator
// ---------------------------------------------------------------------------

/**
 * unfiled and filed are both live rows; retired is its own state whatever the
 * subject; no-master is the live rows with neither a master link nor a master
 * in the bucket, the gap a team closes by hand.
 */
export type SearchState = 'all' | 'unfiled' | 'filed' | 'retired' | 'no-master';
export const SEARCH_STATES: readonly SearchState[] = [
  'all',
  'unfiled',
  'filed',
  'retired',
  'no-master',
];

export interface SearchFilters {
  /** Free text; '' lists everything the filters allow, newest first. */
  q: string;
  subject: string | null;
  tag: string | null;
  /** The exact camera text an upload recorded; a facet value, not free text. */
  camera: string | null;
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
  cameras: Facet[];
}

/** Subjects, tags and cameras with more than this many values show the most used ones. */
export const FACET_SUBJECTS = 50;
export const FACET_TAGS = 30;
export const FACET_CAMERAS = 20;

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
 * bm25 rank come from the index (subject, tags and title weigh most, then alt
 * text and the creator, then the path, credit, camera and lens); the filters
 * then apply to the joined rows. A facet leaves its own filter out, so the
 * list offers the other values.
 */
type FacetKind = 'subject' | 'tag' | 'camera';

function searchSql(f: SearchFilters, omit: FacetKind | null = null): SearchSql {
  const params: unknown[] = [];
  const bind = (v: unknown) => {
    params.push(v);
    return `?${params.length}`;
  };
  const match = ftsQuery(f.q);
  const from = match
    ? `assets a JOIN (SELECT rowid, bm25(assets_fts, 1.0, 3.0, 3.0, 2.0, 1.0, 1.0, 1.0, 3.0, 2.0) AS rank
         FROM assets_fts WHERE assets_fts MATCH ${bind(match)}) m ON m.rowid = a.rowid`
    : 'assets a';
  const clauses: string[] = [];
  if (f.subject !== null && omit !== 'subject') clauses.push(`a.subject = ${bind(f.subject)}`);
  if (f.tag !== null && omit !== 'tag')
    clauses.push(`EXISTS (SELECT 1 FROM json_each(a.tags) WHERE value = ${bind(f.tag)})`);
  if (f.camera !== null && omit !== 'camera') clauses.push(`a.camera = ${bind(f.camera)}`);
  if (f.state === 'unfiled') clauses.push('a.subject IS NULL AND a.retired = 0');
  else if (f.state === 'filed') clauses.push('a.subject IS NOT NULL AND a.retired = 0');
  else if (f.state === 'retired') clauses.push('a.retired = 1');
  else if (f.state === 'no-master')
    clauses.push('a.master_url IS NULL AND a.master_key IS NULL AND a.retired = 0');
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

/** The subjects, tags and cameras among the matches, most used first, each counted without its own filter. */
export async function searchFacets(db: Db, filters: SearchFilters): Promise<SearchFacets> {
  const bySubject = searchSql(filters, 'subject');
  const byTag = searchSql(filters, 'tag');
  const byCamera = searchSql(filters, 'camera');
  const [subjects, tags, cameras] = await Promise.all([
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
    db
      .prepare(
        `SELECT a.camera AS value, COUNT(*) AS n FROM ${byCamera.from}${whereOf(
          byCamera.where,
          'a.camera IS NOT NULL',
        )} GROUP BY a.camera ORDER BY n DESC, value LIMIT ?${byCamera.params.length + 1}`,
      )
      .bind(...byCamera.params, FACET_CAMERAS)
      .all<Facet>(),
  ]);
  return { subjects: subjects.results, tags: tags.results, cameras: cameras.results };
}

// ---------------------------------------------------------------------------
// Expiry: what runs out soon, and retiring what has
// ---------------------------------------------------------------------------

/** How far ahead the Expiring view and its badge look. */
export const EXPIRING_DAYS = 30;

/**
 * Files not yet retired whose rights run out within `days` of `today`, or
 * already have: soonest first, so the expired ones lead. A file expiring
 * today is still in date (expiry is `expires_at < today`).
 */
export async function listExpiring(
  db: Db,
  today: string,
  days = EXPIRING_DAYS,
  limit = 500,
): Promise<Asset[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM assets WHERE retired = 0 AND expires_at IS NOT NULL AND expires_at <= ?1
       ORDER BY expires_at, key LIMIT ?2`,
    )
    .bind(plusDays(today, days), limit)
    .all<AssetRow>();
  return results.map(fromRow);
}

export async function countExpiring(db: Db, today: string, days = EXPIRING_DAYS): Promise<number> {
  const r = await db
    .prepare(
      'SELECT COUNT(*) AS n FROM assets WHERE retired = 0 AND expires_at IS NOT NULL AND expires_at <= ?1',
    )
    .bind(plusDays(today, days))
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** Who the audit log names for the expiry rule's own writes. */
export const EXPIRY_ACTOR = 'system:expiry';

export interface ExpiryReport {
  today: string;
  /** The keys retired by this run, soonest expiry first. */
  retired: string[];
}

/**
 * Retires every file whose expiry date has passed (`expires_at < today`),
 * noting `Expired <date>` on each, with one audit row per file and one for
 * the run. A file's change and its audit row sit side by side in the same
 * batch, so neither lands without the other.
 * Only rows not yet retired are touched, so a second run on the same day
 * retires nothing and only adds its own summary row: the daily row is how an
 * operator can see the cron is alive. `requestedBy` names the person behind
 * a manual run; the rule itself is the actor.
 */
export async function retireExpired(
  db: Db,
  today: string,
  requestedBy?: string,
): Promise<ExpiryReport> {
  if (!isIsoDate(today)) throw new Error(`Not a date: ${today}`);
  const { results } = await db
    .prepare(
      `SELECT key, expires_at FROM assets WHERE retired = 0 AND expires_at IS NOT NULL AND expires_at < ?1
       ORDER BY expires_at, key`,
    )
    .bind(today)
    .all<{ key: string; expires_at: string }>();
  const statements = results.flatMap((r) => {
    const note = `Expired ${r.expires_at}`;
    return [
      // The guard repeats the selection: a person retiring the file between
      // the read and the write keeps their own note.
      db
        .prepare(
          `UPDATE assets SET retired = 1, retired_note = ?2
           WHERE key = ?1 AND retired = 0 AND expires_at < ?3`,
        )
        .bind(r.key, note, today),
      auditStatement(db, {
        actor: EXPIRY_ACTOR,
        action: 'library.retired',
        detail: { key: r.key, note, expires_at: r.expires_at },
      }),
    ];
  });
  statements.push(
    auditStatement(db, {
      actor: EXPIRY_ACTOR,
      action: 'library.expiry_run',
      detail: {
        today,
        count: results.length,
        keys: results.map((r) => r.key),
        ...(requestedBy ? { requested_by: requestedBy } : {}),
      },
    }),
  );
  await batchAll(db, statements);
  return { today, retired: results.map((r) => r.key) };
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

export type ReplaceStatus = 'ok' | 'same-file' | 'too-big' | 'bad-name' | 'missing';

export interface ReplaceAnswer {
  key: string;
  status: ReplaceStatus;
  message: string;
}

/** The hash the store or the library knows for a key's current bytes, if either does. */
export const knownSha256 = (
  head: { customMetadata?: Record<string, string> } | null,
  asset: Asset | null,
): string | null => head?.customMetadata?.sha256 ?? asset?.sha256 ?? null;

/**
 * What the browser asks before it sends a replacement: the key must hold an
 * object in a web format, the file must be under the cap, and the same bytes
 * again are refused as a no-op rather than written and purged for nothing.
 */
export async function replacePrecheck(
  db: Db,
  bucket: MediaBucket,
  layout: MediaLayout,
  entry: PrecheckEntry,
): Promise<ReplaceAnswer> {
  const { key } = entry;
  if (!isLibraryKey(layout, key) || !WEB_IMAGE_KEY.test(key))
    return { key, status: 'bad-name', message: 'Not a key the library can replace.' };
  if (!HASH.test(entry.sha256))
    return { key, status: 'bad-name', message: 'No content hash was sent.' };
  if (entry.size > UPLOAD_MAX_BYTES) return { key, status: 'too-big', message: TOO_BIG };
  const head = await bucket.head(key);
  if (!head) return { key, status: 'missing', message: 'This key is not in the bucket.' };
  if (knownSha256(head, await getAsset(db, key)) === entry.sha256)
    return {
      key,
      status: 'same-file',
      message: 'The same bytes are already at this key; nothing to replace.',
    };
  return { key, status: 'ok', message: 'Ready to replace.' };
}

// ---------------------------------------------------------------------------
// Rescan: walk the bucket, refresh what the library knows
// ---------------------------------------------------------------------------

export interface RescanReport {
  listed: number;
  added: number;
  /** Upload records completed from the objects' own metadata. */
  completed: number;
  /** Keys whose bytes were replaced outside the library (the etag moved). */
  changed: string[];
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
  const changed: string[] = [];
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
      changed.push(...seen.changed);
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
  return { listed, added, completed, changed, forgotten: gone.length };
}
