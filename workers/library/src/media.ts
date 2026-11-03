/**
 * The media bucket and the rules for its keys. The bucket listing is the
 * record of what exists (`library.ts` keeps metadata about keys); uploads go
 * straight into the bucket by path, and the resizer serves and resizes them
 * at their own path. Nothing overwrites an object; the one door that removes
 * one is the file page's Delete button, a person's confirmed act.
 */
import { UPLOAD_MAX_BYTES, UPLOAD_MAX_LABEL } from '@photonrelic/media-params';

export { UPLOAD_MAX_BYTES, UPLOAD_MAX_LABEL };

export interface MediaObject {
  key: string;
  size: number;
  uploaded: string | null;
  /** The object's etag from the listing: MD5 for single-part uploads, a composite otherwise. */
  etag: string | null;
  /** What an upload stamped on the object (sha256, uploadedBy, source), when the listing carries it. */
  customMetadata?: Record<string, string>;
}

export interface MediaListing {
  objects: MediaObject[];
  /** Sub-folders under the prefix when listing with a delimiter. */
  prefixes: string[];
  cursor: string | null;
}

export interface PutOptions {
  /** Custom metadata kept on the object itself, so the bucket is self-describing. */
  customMetadata?: Record<string, string>;
}

export interface MediaBucket {
  put(
    key: string,
    body: ReadableStream | ArrayBuffer | string,
    contentType: string,
    opts?: PutOptions,
  ): Promise<void>;
  get(key: string): Promise<{ body: ReadableStream; contentType: string; size: number } | null>;
  /** Existence and size without the body, with the custom metadata an upload stamped on the object. */
  head(key: string): Promise<{
    size: number;
    contentType: string;
    etag: string | null;
    customMetadata?: Record<string, string>;
  } | null>;
  /** Removes the object for good; a key that does not exist is not an error. */
  delete(key: string): Promise<void>;
  /**
   * A multipart upload the browser fills by presigned part URLs (masters):
   * started and completed here, so both are the library's own acts.
   */
  createMultipart(key: string, contentType: string): Promise<{ uploadId: string }>;
  completeMultipart(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
  /** One page of keys under a prefix; with a delimiter, folders come back as prefixes. */
  list(
    prefix: string,
    opts?: { delimiter?: string; cursor?: string; limit?: number },
  ): Promise<MediaListing>;
}

/** What the library stamps on every object it uploads, so a rescan can recognize its own. */
export const UPLOAD_SOURCE_TAG = 'photonrelic';

// ---------------------------------------------------------------------------
// Layout: where uploads go and what the library lists
// ---------------------------------------------------------------------------

export interface MediaLayout {
  /** Uploads are `<uploadPrefix><subject>/<name>.<ext>`. */
  uploadPrefix: string;
  /** The roots the library lists; always includes uploadPrefix. */
  libraryPrefixes: string[];
}

const PREFIX = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*\/$/;

/** The layout from the Worker vars; a malformed prefix throws, so a bad deploy fails loudly. */
export function layoutFromVars(upload?: string, library?: string): MediaLayout {
  const uploadPrefix = (upload ?? '').trim() || 'media/';
  const listed = (library ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const libraryPrefixes = [...new Set([uploadPrefix, ...listed])];
  for (const p of libraryPrefixes)
    if (!PREFIX.test(p)) throw new Error(`Not a bucket prefix (lowercase, ending in /): ${p}`);
  for (const p of libraryPrefixes)
    for (const q of libraryPrefixes)
      if (p !== q && q.startsWith(p)) throw new Error(`Library prefixes overlap: ${p} and ${q}`);
  return { uploadPrefix, libraryPrefixes };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What the library accepts as an upload key: <prefix><subject...>/<name>.<ext>, lowercase, hyphens. */
export const uploadKeyPattern = (layout: MediaLayout): RegExp =>
  new RegExp(
    `^${escapeRe(layout.uploadPrefix)}[a-z0-9][a-z0-9-]*(?:/[a-z0-9][a-z0-9-]*)*/[a-z0-9][a-z0-9-]*\\.(?:jpe?g|png|webp|avif|gif)$`,
  );

/** A key the library will show or act on: under a listed root, no traversal. */
export const isLibraryKey = (layout: MediaLayout, key: string): boolean =>
  Boolean(key) && !key.includes('..') && layout.libraryPrefixes.some((p) => key.startsWith(p));

/** Image files only; a stray text file in the bucket is not a photo. */
export const IMAGE_KEY = /\.(?:jpe?g|png|webp|avif|gif|tiff?|heic)$/i;

export const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
};

export const contentTypeFor = (key: string): string =>
  CONTENT_TYPES[key.slice(key.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';

/** The formats the browser may send and the resizer can take; a Replace must keep to these. */
export const WEB_IMAGE_KEY = /\.(?:jpe?g|png|webp|avif|gif)$/i;

/**
 * The image format the first bytes declare, or null. A Replace writes over a
 * key other pages already link to, so the bytes must be what the extension
 * says: a PNG under a .jpg key would serve with the wrong type for a day.
 */
export function sniffImageType(bytes: ArrayBuffer): string | null {
  const b = new Uint8Array(bytes);
  const at = (i: number, ...want: number[]) => want.every((v, j) => b[i + j] === v);
  const ascii = (i: number, s: string) => at(i, ...[...s].map((ch) => ch.charCodeAt(0)));
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(4, 'ftyp')) {
    // An ISO media file: the ftyp box lists its brands, major first, from byte 8;
    // some encoders put `avif` among the compatible brands under a `mif1` major.
    const size = ((b[0] ?? 0) << 24) | ((b[1] ?? 0) << 16) | ((b[2] ?? 0) << 8) | (b[3] ?? 0);
    for (let i = 8; i + 4 <= Math.min(size, b.length, 64); i += 4) {
      if (ascii(i, 'avif') || ascii(i, 'avis')) return 'image/avif';
    }
  }
  return null;
}

/**
 * The subject folder of an upload key (`media/products/chairs/x.jpg` →
 * `products/chairs`); null for a key outside the upload prefix or at its root.
 */
export function subjectOf(layout: MediaLayout, key: string): string | null {
  if (!key.startsWith(layout.uploadPrefix)) return null;
  const rest = key.slice(layout.uploadPrefix.length);
  const cut = rest.lastIndexOf('/');
  return cut > 0 ? rest.slice(0, cut) : null;
}

export const basenameOf = (key: string): string => key.slice(key.lastIndexOf('/') + 1);

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The memory bucket's etag: a content hash, as R2's is for a single-part upload (MD5 there). */
async function memoryEtag(bytes: ArrayBuffer): Promise<string> {
  return (await sha256Hex(bytes)).slice(0, 32);
}

// ---------------------------------------------------------------------------
// Workers bindings
// ---------------------------------------------------------------------------

export class R2MediaBucket implements MediaBucket {
  constructor(private readonly bucket: R2Bucket) {}
  async put(
    key: string,
    body: ReadableStream | ArrayBuffer | string,
    contentType: string,
    opts: PutOptions = {},
  ): Promise<void> {
    await this.bucket.put(key, body, {
      httpMetadata: { contentType, cacheControl: 'public, max-age=60' },
      ...(opts.customMetadata ? { customMetadata: opts.customMetadata } : {}),
    });
  }
  async get(key: string) {
    const o = await this.bucket.get(key);
    return o
      ? {
          body: o.body,
          contentType: o.httpMetadata?.contentType ?? 'application/octet-stream',
          size: o.size,
        }
      : null;
  }
  async createMultipart(key: string, contentType: string) {
    const u = await this.bucket.createMultipartUpload(key, {
      httpMetadata: { contentType },
      customMetadata: { source: UPLOAD_SOURCE_TAG },
    });
    return { uploadId: u.uploadId };
  }
  async completeMultipart(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ) {
    await this.bucket.resumeMultipartUpload(key, uploadId).complete(parts);
  }
  async abortMultipart(key: string, uploadId: string) {
    await this.bucket.resumeMultipartUpload(key, uploadId).abort();
  }
  async head(key: string) {
    const o = await this.bucket.head(key);
    return o
      ? {
          size: o.size,
          contentType: o.httpMetadata?.contentType ?? 'application/octet-stream',
          etag: o.etag ?? null,
          ...(o.customMetadata ? { customMetadata: o.customMetadata } : {}),
        }
      : null;
  }
  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
  async list(
    prefix: string,
    opts: { delimiter?: string; cursor?: string; limit?: number } = {},
  ): Promise<MediaListing> {
    const r = await this.bucket.list({
      prefix,
      limit: opts.limit ?? 500,
      include: ['customMetadata'],
      ...(opts.delimiter ? { delimiter: opts.delimiter } : {}),
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
    });
    return {
      objects: r.objects.map((o) => ({
        key: o.key,
        size: o.size,
        uploaded: o.uploaded ? o.uploaded.toISOString() : null,
        etag: o.etag ?? null,
        ...(o.customMetadata && Object.keys(o.customMetadata).length
          ? { customMetadata: o.customMetadata }
          : {}),
      })),
      prefixes: r.delimitedPrefixes,
      cursor: r.truncated ? r.cursor : null,
    };
  }
}

/** Test and local-development stand-in. Etags are content hashes, as R2's are for single-part uploads. */
export class MemoryMediaBucket implements MediaBucket {
  readonly objects = new Map<
    string,
    {
      bytes: ArrayBuffer;
      contentType: string;
      etag: string;
      customMetadata?: Record<string, string>;
    }
  >();
  async put(
    key: string,
    body: ReadableStream | ArrayBuffer | string,
    contentType: string,
    opts: PutOptions = {},
  ): Promise<void> {
    const bytes =
      typeof body === 'string'
        ? (new TextEncoder().encode(body).buffer as ArrayBuffer)
        : body instanceof ArrayBuffer
          ? body
          : await new Response(body).arrayBuffer();
    this.objects.set(key, {
      bytes,
      contentType,
      etag: await memoryEtag(bytes),
      ...(opts.customMetadata ? { customMetadata: opts.customMetadata } : {}),
    });
  }
  async get(key: string) {
    const o = this.objects.get(key);
    return o
      ? {
          body: new Response(o.bytes).body as ReadableStream,
          contentType: o.contentType,
          size: o.bytes.byteLength,
        }
      : null;
  }
  async head(key: string) {
    const o = this.objects.get(key);
    return o
      ? {
          size: o.bytes.byteLength,
          contentType: o.contentType,
          etag: o.etag,
          ...(o.customMetadata ? { customMetadata: o.customMetadata } : {}),
        }
      : null;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  /** Multipart uploads in flight: parts arrive through `putPart`, as a presigned PUT would land them. */
  readonly multipart = new Map<
    string,
    { key: string; contentType: string; parts: Map<number, { bytes: ArrayBuffer; etag: string }> }
  >();
  async createMultipart(key: string, contentType: string) {
    const uploadId = `mp-${this.multipart.size + 1}-${key.replace(/[^a-z0-9]/g, '')}`;
    this.multipart.set(uploadId, { key, contentType, parts: new Map() });
    return { uploadId };
  }
  async putPart(uploadId: string, partNumber: number, bytes: ArrayBuffer): Promise<string> {
    const u = this.multipart.get(uploadId);
    if (!u) throw new Error('no such upload');
    const etag = await memoryEtag(bytes);
    u.parts.set(partNumber, { bytes, etag });
    return etag;
  }
  async completeMultipart(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ) {
    const u = this.multipart.get(uploadId);
    if (!u || u.key !== key) throw new Error('no such upload');
    const chunks: Uint8Array[] = [];
    for (const p of [...parts].sort((a, b) => a.partNumber - b.partNumber)) {
      const had = u.parts.get(p.partNumber);
      if (!had || had.etag !== p.etag) throw new Error(`part ${p.partNumber} does not match`);
      chunks.push(new Uint8Array(had.bytes));
    }
    const all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.byteLength;
    }
    this.multipart.delete(uploadId);
    await this.put(key, all.buffer as ArrayBuffer, u.contentType, {
      customMetadata: { source: UPLOAD_SOURCE_TAG },
    });
  }
  async abortMultipart(_key: string, uploadId: string) {
    this.multipart.delete(uploadId);
  }
  async list(
    prefix: string,
    opts: { delimiter?: string; cursor?: string; limit?: number } = {},
  ): Promise<MediaListing> {
    const objects: MediaObject[] = [];
    const prefixes = new Set<string>();
    for (const [key, o] of [...this.objects].sort(([a], [b]) => a.localeCompare(b))) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const cut = opts.delimiter ? rest.indexOf(opts.delimiter) : -1;
      if (cut >= 0) prefixes.add(prefix + rest.slice(0, cut + 1));
      else
        objects.push({
          key,
          size: o.bytes.byteLength,
          uploaded: null,
          etag: o.etag,
          ...(o.customMetadata ? { customMetadata: o.customMetadata } : {}),
        });
    }
    return { objects, prefixes: [...prefixes], cursor: null };
  }
}
