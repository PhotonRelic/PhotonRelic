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
