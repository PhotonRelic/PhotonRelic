/**
 * Where the resizer reads objects: an R2 bucket in production, a map in
 * tests. Read-only: the resizer never writes or deletes.
 */

export interface StoredObject {
  body: ReadableStream;
  contentType: string;
  size: number;
}

export interface MediaSource {
  get(key: string): Promise<StoredObject | null>;
}

export class R2MediaSource implements MediaSource {
  constructor(private readonly bucket: R2Bucket) {}
  async get(key: string): Promise<StoredObject | null> {
    const o = await this.bucket.get(key);
    return o
      ? {
          body: o.body,
          contentType: o.httpMetadata?.contentType ?? 'application/octet-stream',
          size: o.size,
        }
      : null;
  }
}

export class MemoryMediaSource implements MediaSource {
  readonly objects = new Map<string, { bytes: ArrayBuffer; contentType: string }>();
  put(key: string, bytes: ArrayBuffer, contentType: string): void {
    this.objects.set(key, { bytes, contentType });
  }
  async get(key: string): Promise<StoredObject | null> {
    const o = this.objects.get(key);
    return o
      ? {
          body: new Response(o.bytes).body as ReadableStream,
          contentType: o.contentType,
          size: o.bytes.byteLength,
        }
      : null;
  }
}

const PREFIX = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*\/$/;

/** SERVED_PREFIXES as a list; each must be a lowercase folder path ending in `/`. */
export function parsePrefixes(raw: string | undefined): string[] {
  const list = (raw ?? 'media/')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  for (const p of list) if (!PREFIX.test(p)) throw new Error(`Not a served prefix: ${p}`);
  if (list.length === 0) throw new Error('SERVED_PREFIXES is empty');
  return list;
}

/**
 * Keys the resizer will serve: under a served prefix, path segments of
 * letters, digits, `.`, `_` and `-`, an image extension. No traversal, no
 * empty segments, no SVG (a script-capable format has no place on a public
 * image host).
 */
const KEY_REST =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*\.(?:jpe?g|png|webp|avif|gif)$/i;

/**
 * Masters (the .ai, .psd and raw originals the library keeps beside the web
 * copies) are never served, whatever SERVED_PREFIXES says: the refusal is in
 * code, before any configuration is consulted, so no deployment can list
 * them by mistake.
 */
export const MASTERS_PREFIX = 'masters/';

export function isServableKey(key: string, prefixes: readonly string[]): boolean {
  if (key.includes('..') || key.startsWith(MASTERS_PREFIX)) return false;
  const prefix = prefixes.find((p) => key.startsWith(p));
  return prefix !== undefined && KEY_REST.test(key.slice(prefix.length));
}
