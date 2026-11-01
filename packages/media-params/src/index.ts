/**
 * The resize menu for `GET /<key>`. Dependency-free, so the resizer, the
 * library and any site that builds image URLs can import the same menu.
 *
 *   ?w=<width>              one of the menu's widths; scale-down, aspect kept
 *   ?w=<width>&ar=<a:b>     one of the menu's aspect ratios; cover crop, gravity auto
 *   ?f=avif|webp|jpeg|auto  auto (the default) follows the Accept header
 *
 * A fixed menu bounds the number of unique transformations anyone can request,
 * and with it the Images bill: each unique source-and-parameters pair counts.
 */

export const DEFAULT_WIDTHS = [160, 320, 480, 768, 1024, 1440, 2048] as const;
export const DEFAULT_ASPECTS = ['1:1', '4:3', '3:2', '8:5', '16:9'] as const;

export const MEDIA_FORMATS = ['avif', 'webp', 'jpeg', 'auto'] as const;
export type MediaFormat = (typeof MEDIA_FORMATS)[number];

export type MediaOutputFormat = Exclude<MediaFormat, 'auto'>;
export type MediaOutputMime = 'image/avif' | 'image/webp' | 'image/jpeg';

export const MEDIA_MIME: Record<MediaOutputFormat, MediaOutputMime> = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
};

/** Sources above this are served as stored: the Images binding takes 20 MB at most. */
export const MAX_TRANSFORM_SOURCE_BYTES = 20 * 1024 * 1024;

/**
 * The largest upload the library accepts. 19.95 MB in decimal bytes stays under
 * the resizer's 20 MB input cap on either reading of the unit, so nothing is
 * stored that could not be resized.
 */
export const UPLOAD_MAX_BYTES = 19_950_000;
export const UPLOAD_MAX_LABEL = '19.95 MB';

/** Cloudflare Images transformation limit on either edge of the output. */
const MAX_EDGE = 12_000;

export interface ResizeMenu {
  widths: readonly number[];
  aspects: readonly string[];
}

export const DEFAULT_MENU: ResizeMenu = { widths: DEFAULT_WIDTHS, aspects: DEFAULT_ASPECTS };

const ASPECT = /^([1-9]\d{0,2}):([1-9]\d{0,2})$/;

/**
 * A menu from two comma-separated lists (Worker vars). An unset or empty list
 * keeps the default; a malformed entry throws, so a bad deploy fails loudly
 * rather than serving a menu nobody meant.
 */
export function menuFromLists(widths?: string, aspects?: string): ResizeMenu {
  const split = (s: string | undefined) =>
    (s ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  const w = split(widths);
  const a = split(aspects);
  for (const x of w) {
    const n = Number(x);
    if (!Number.isInteger(n) || n < 1 || n > MAX_EDGE)
      throw new Error(`Not a width: ${x} (whole pixels, 1 to ${MAX_EDGE})`);
  }
  for (const x of a) if (!ASPECT.test(x)) throw new Error(`Not an aspect ratio: ${x} (a:b)`);
  return {
    widths: w.length ? [...new Set(w.map(Number))].sort((p, q) => p - q) : DEFAULT_WIDTHS,
    aspects: a.length ? [...new Set(a)] : DEFAULT_ASPECTS,
  };
}

export interface MediaTransformParams {
  width: number;
  /** Set only with an aspect ratio: a cover crop to width x height. */
  height?: number;
  fit: 'scale-down' | 'cover';
  /** As requested, `auto` included; `resolved` is what will be produced. */
  format: MediaFormat;
  resolved: MediaOutputFormat;
}

export type MediaParamsResult =
  | { kind: 'none' }
  | { kind: 'transform'; params: MediaTransformParams }
  | { kind: 'error'; message: string };

const PARAM_KEYS = new Set(['w', 'ar', 'f']);

/** Parse the resize parameters from a request URL. `accept` is the request's Accept header. */
export function parseMediaParams(
  url: URL,
  accept: string | null,
  menu: ResizeMenu = DEFAULT_MENU,
): MediaParamsResult {
  const keys = [...url.searchParams.keys()];
  if (keys.length === 0) return { kind: 'none' };
  const unknown = keys.filter((k) => !PARAM_KEYS.has(k));
  if (unknown.length) return { kind: 'error', message: `Unknown parameter: ${unknown[0]}` };

  const wRaw = url.searchParams.get('w');
  const arRaw = url.searchParams.get('ar');
  const fRaw = url.searchParams.get('f') ?? 'auto';

  if (!(MEDIA_FORMATS as readonly string[]).includes(fRaw)) {
    return { kind: 'error', message: `f must be one of ${MEDIA_FORMATS.join(', ')}` };
  }
  const format = fRaw as MediaFormat;

  if (wRaw === null) {
    if (arRaw !== null) return { kind: 'error', message: 'ar needs w' };
    // f alone: a format change at the source size is not on the menu.
    return { kind: 'error', message: 'f needs w' };
  }
  const width = Number(wRaw);
  if (!menu.widths.includes(width)) {
    return { kind: 'error', message: `w must be one of ${menu.widths.join(', ')}` };
  }

  let height: number | undefined;
  let fit: 'scale-down' | 'cover' = 'scale-down';
  if (arRaw !== null) {
    if (!menu.aspects.includes(arRaw)) {
      return { kind: 'error', message: `ar must be one of ${menu.aspects.join(', ')}` };
    }
    const [a, b] = arRaw.split(':').map(Number) as [number, number];
    height = Math.round((width * b) / a);
    if (height > MAX_EDGE) return { kind: 'error', message: 'That crop is taller than 12,000 px' };
    fit = 'cover';
  }

  const params: MediaTransformParams = {
    width,
    fit,
    format,
    resolved: format === 'auto' ? negotiateFormat(accept) : format,
  };
  if (height !== undefined) params.height = height;
  return { kind: 'transform', params };
}

/** avif if the client accepts it, else webp, else jpeg. */
export function negotiateFormat(accept: string | null): MediaOutputFormat {
  const a = (accept ?? '').toLowerCase();
  if (a.includes('image/avif')) return 'avif';
  if (a.includes('image/webp')) return 'webp';
  return 'jpeg';
}

/**
 * The public URL for a key, optionally resized. The resizer serves a key at
 * its own path: `media/products/chair.jpg` is `<origin>/media/products/chair.jpg`.
 */
export function mediaUrl(
  origin: string,
  key: string,
  opts: { w?: number; ar?: string; f?: MediaFormat } = {},
): string {
  const path = key.split('/').map(encodeURIComponent).join('/');
  const base = `${origin.replace(/\/$/, '')}/${path}`;
  if (opts.w === undefined) return base;
  const q = new URLSearchParams({ w: String(opts.w) });
  if (opts.ar) q.set('ar', opts.ar);
  q.set('f', opts.f ?? 'auto');
  return `${base}?${q}`;
}

/** Analytics Engine takes one index per data point, of at most this many bytes. */
export const USAGE_INDEX_MAX_BYTES = 96;

/**
 * The Analytics Engine index for a key: the key itself when it fits, else a
 * stable hash of it (FNV-1a 64, hex, marked with `#` so it can never collide
 * with a real key, which always starts with a served prefix). The resizer
 * writes it and the library queries by it, so both import this one function
 * and a long key is counted rather than dropped.
 */
export function usageIndex(key: string): string {
  const bytes = new TextEncoder().encode(key);
  if (bytes.byteLength <= USAGE_INDEX_MAX_BYTES) return key;
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return `#${h.toString(16).padStart(16, '0')}`;
}

/**
 * The resizer's public metadata API: `GET /api/v1/assets/<key>` and
 * `GET /api/v1/assets?prefix=&subject=&tag=&limit=&cursor=`. A site that
 * embeds images can fetch alt text, dimensions and credit for a key without
 * going through the library, which sits behind Access. Read only, and only
 * what the library filed: no audit trail, no identities.
 */
export interface AssetRecord {
  key: string;
  bytes: number | null;
  contentType: string | null;
  width: number | null;
  height: number | null;
  subject: string | null;
  tags: string[];
  alt: string;
  credit: string | null;
  /** ISO 8601, when the library first saw the key. */
  firstSeen: string;
  /**
   * What the upload recorded about the original before the prep tool stripped
   * its tags: the capture date as the camera wrote it (no timezone guessed),
   * the camera's make and model, the lens, and the pixel size before any
   * resize. Null when nothing was recorded; a Rescan never fills these.
   */
  capturedAt: string | null;
  camera: string | null;
  lens: string | null;
  originalWidth: number | null;
  originalHeight: number | null;
}

export interface AssetResponse {
  ok: true;
  asset: AssetRecord;
}

export interface AssetListResponse {
  ok: true;
  assets: AssetRecord[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  cursor: string | null;
}

export interface AssetListQuery {
  /** A key prefix under the resizer's served prefixes; unset lists them all. */
  prefix?: string;
  subject?: string;
  tag?: string;
  /** 1 to 500; the resizer's default is 100. */
  limit?: number;
  cursor?: string;
}

export const ASSETS_PATH = '/api/v1/assets';

/** The metadata URL for a key, encoded per segment like `mediaUrl`. */
export function assetUrl(origin: string, key: string): string {
  const path = key.split('/').map(encodeURIComponent).join('/');
  return `${origin.replace(/\/$/, '')}${ASSETS_PATH}/${path}`;
}

/** The listing URL; only the filters given appear in the query string. */
export function assetListUrl(origin: string, opts: AssetListQuery = {}): string {
  const q = new URLSearchParams();
  if (opts.prefix !== undefined) q.set('prefix', opts.prefix);
  if (opts.subject !== undefined) q.set('subject', opts.subject);
  if (opts.tag !== undefined) q.set('tag', opts.tag);
  if (opts.limit !== undefined) q.set('limit', String(opts.limit));
  if (opts.cursor !== undefined) q.set('cursor', opts.cursor);
  const base = `${origin.replace(/\/$/, '')}${ASSETS_PATH}`;
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}
