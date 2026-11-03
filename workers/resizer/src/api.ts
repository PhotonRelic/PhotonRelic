/**
 * The public metadata API's reads: one asset by key, or a page of assets
 * filtered by prefix, subject and tag, in key order. Only what the library
 * filed about a key leaves here (alt text, dimensions, credit, tags, the
 * title, creator, copyright and origin a file carried); the hashes, the
 * audit trail, who did what, and where the master is kept stay behind
 * Access.
 *
 * Keys are checked against the served prefixes only, not the image route's
 * stricter name rule: the library files whatever the bucket holds, spaces
 * and all, and a build that found such a key in the library should still be
 * able to ask about it. A retired key is not found, though it still serves
 * as an image: retiring is how the library says "stop using this".
 */
import type { AssetRecord } from '@photonrelic/media-params';
import type { Db } from './db.js';
import { MASTERS_PREFIX } from './source.js';

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;

interface Row {
  key: string;
  bytes: number | null;
  content_type: string | null;
  width: number | null;
  height: number | null;
  subject: string | null;
  tags: string;
  alt_default: string;
  credit: string | null;
  title: string | null;
  creator: string | null;
  copyright: string | null;
  origin: string | null;
  first_seen: string;
  captured_at: string | null;
  camera: string | null;
  lens: string | null;
  original_width: number | null;
  original_height: number | null;
  focal_x: number | null;
  focal_y: number | null;
}

const COLUMNS =
  'key, bytes, content_type, width, height, subject, tags, alt_default, credit, title, creator, copyright, origin, first_seen, captured_at, camera, lens, original_width, original_height, focal_x, focal_y';

/** A focal point is two halves; one without the other is no point at all. */
const focalOf = (r: { focal_x: number | null; focal_y: number | null }) =>
  r.focal_x !== null && r.focal_y !== null ? { x: r.focal_x, y: r.focal_y } : null;

function fromRow(r: Row): AssetRecord {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(r.tags) as unknown;
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    // a malformed row shows no tags rather than failing the request
  }
  return {
    key: r.key,
    bytes: r.bytes,
    contentType: r.content_type,
    width: r.width,
    height: r.height,
    subject: r.subject,
    tags,
    alt: r.alt_default,
    credit: r.credit,
    title: r.title,
    creator: r.creator,
    copyright: r.copyright,
    origin: r.origin,
    firstSeen: r.first_seen,
    capturedAt: r.captured_at,
    camera: r.camera,
    lens: r.lens,
    originalWidth: r.original_width,
    originalHeight: r.original_height,
    focal: focalOf(r),
  };
}

/**
 * The focal point for a cover crop, retired or not: a retired key still
 * serves as an image wherever it is already used, and should still crop the
 * way it was set. Read on the cold path only; the cached output has it baked
 * in, and the library purges the crops when the point changes.
 */
export async function getFocal(db: Db, key: string): Promise<{ x: number; y: number } | null> {
  const r = await db
    .prepare('SELECT focal_x, focal_y FROM assets WHERE key = ?1')
    .bind(key)
    .first<{ focal_x: number | null; focal_y: number | null }>();
  return r ? focalOf(r) : null;
}

/** Under one of the served prefixes, with no traversal. */
export function isUnderPrefix(key: string, prefixes: readonly string[]): boolean {
  return (
    Boolean(key) &&
    !key.includes('..') &&
    !key.startsWith(MASTERS_PREFIX) &&
    prefixes.some((p) => key.startsWith(p))
  );
}

export async function getAsset(db: Db, key: string): Promise<AssetRecord | null> {
  const r = await db
    .prepare(`SELECT ${COLUMNS} FROM assets WHERE key = ?1 AND retired = 0`)
    .bind(key)
    .first<Row>();
  return r ? fromRow(r) : null;
}

export interface ListQuery {
  /** One prefix to list, or every served prefix when null. */
  prefix: string | null;
  subject: string | null;
  tag: string | null;
  limit: number;
  /** Keys after this one (the decoded cursor). */
  after: string | null;
}

export type ListQueryResult = { kind: 'ok'; query: ListQuery } | { kind: 'error'; message: string };

const QUERY_KEYS = new Set(['prefix', 'subject', 'tag', 'limit', 'cursor']);

/** The listing's query string, checked the way the resize menu is: anything off it is an error. */
export function parseListQuery(
  params: URLSearchParams,
  prefixes: readonly string[],
): ListQueryResult {
  const unknown = [...params.keys()].find((k) => !QUERY_KEYS.has(k));
  if (unknown !== undefined) return { kind: 'error', message: `Unknown parameter: ${unknown}` };

  const prefix = params.get('prefix');
  if (prefix !== null && !isUnderPrefix(prefix, prefixes)) {
    return { kind: 'error', message: `prefix must be under ${prefixes.join(', ')}` };
  }

  let limit = DEFAULT_LIMIT;
  const limitRaw = params.get('limit');
  if (limitRaw !== null) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return { kind: 'error', message: `limit must be a whole number from 1 to ${MAX_LIMIT}` };
    }
  }

  let after: string | null = null;
  const cursor = params.get('cursor');
  if (cursor !== null) {
    after = decodeCursor(cursor);
    if (after === null) return { kind: 'error', message: 'cursor is not one this API issued' };
  }

  return {
    kind: 'ok',
    query: { prefix, subject: params.get('subject'), tag: params.get('tag'), limit, after },
  };
}

/**
 * The key range for a prefix: everything from the prefix itself up to, but
 * not including, the prefix with its last character stepped up. SQLite
 * compares text byte-wise and UTF-8 keeps code point order, so the range is
 * exact and uses the primary key index, which `LIKE` would not.
 */
function prefixRange(prefix: string): [string, string] {
  const chars = [...prefix];
  const last = chars.pop() ?? '';
  const upper = `${chars.join('')}${String.fromCodePoint((last.codePointAt(0) ?? 0) + 1)}`;
  return [prefix, upper];
}

export async function listAssets(
  db: Db,
  q: ListQuery,
  prefixes: readonly string[],
): Promise<{ assets: AssetRecord[]; cursor: string | null }> {
  const where: string[] = ['retired = 0'];
  const args: unknown[] = [];
  const ranges = (q.prefix === null ? prefixes : [q.prefix]).map((p) => {
    const [lo, hi] = prefixRange(p);
    args.push(lo, hi);
    return `(key >= ?${args.length - 1} AND key < ?${args.length})`;
  });
  where.push(`(${ranges.join(' OR ')})`);
  if (q.subject !== null) {
    args.push(q.subject);
    where.push(`subject = ?${args.length}`);
  }
  if (q.tag !== null) {
    // tags is a JSON array of strings; json_each unrolls it per row.
    args.push(q.tag);
    where.push(
      `EXISTS (SELECT 1 FROM json_each(assets.tags) WHERE json_each.value = ?${args.length})`,
    );
  }
  if (q.after !== null) {
    args.push(q.after);
    where.push(`key > ?${args.length}`);
  }
  // One row past the page tells whether there is a next page without a count.
  args.push(q.limit + 1);
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM assets WHERE ${where.join(' AND ')} ORDER BY key LIMIT ?${args.length}`,
    )
    .bind(...args)
    .all<Row>();
  const page = results.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    assets: page.map(fromRow),
    cursor: results.length > q.limit && last ? encodeCursor(last.key) : null,
  };
}

/**
 * The cursor is the last key of the page, base64url-encoded so it survives a
 * query string whatever the key holds. Opaque by contract, not by secrecy:
 * there is nothing in it a caller could not see in the page itself.
 */
export function encodeCursor(key: string): string {
  const bytes = new TextEncoder().encode(key);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The key a cursor names, or null when it is not one `encodeCursor` made. */
export function decodeCursor(cursor: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  let bin: string;
  try {
    bin = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(bin, (ch) => ch.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}
