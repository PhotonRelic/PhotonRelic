import {
  assetListUrl,
  assetUrl,
  DEFAULT_MENU,
  MAX_TRANSFORM_SOURCE_BYTES,
  menuFromLists,
  parseMediaParams,
  variantUrls,
} from '@photonrelic/media-params';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, isUnderPrefix, parseListQuery } from '../src/api.js';
import {
  CACHE_API,
  CACHE_STAFF_ONLY,
  CACHE_STORED,
  CACHE_TRANSFORMED,
  createApp,
  storedCacheKey,
  transformCacheKey,
} from '../src/app.js';
import type { Db, DbStatement } from '../src/db.js';
import {
  decideEmbed,
  type EmbedPolicy,
  embedPolicyFromVars,
  hostMatches,
  libraryHostFromVar,
  parseAllowedOrigins,
} from '../src/embed.js';
import { isExpired } from '../src/expiry.js';
import {
  CloudflareImageTransformer,
  type ImageTransformer,
  TransformFailed,
  type TransformOptions,
} from '../src/images.js';
import {
  isServableKey,
  MemoryMediaSource,
  parsePrefixes,
  servedContentType,
} from '../src/source.js';
import { AnalyticsEngineUsageSink, type UsagePoint, type UsageSink } from '../src/usage.js';
import { SqliteDb } from './sqlite.js';

/** The first bytes of a PNG, enough to be a distinct stored object. */
const png = () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).buffer as ArrayBuffer;

/** The library's `assets` table, reduced to key and expiry, answering the one query the resizer makes. */
class FakeDb implements Db {
  readonly expiries = new Map<string, string | null>();
  queries = 0;
  failing = false;
  prepare(_sql: string): DbStatement {
    const statement = (values: unknown[]): DbStatement => ({
      bind: (...bound: unknown[]) => statement(bound),
      first: async <T>(): Promise<T | null> => {
        this.queries += 1;
        if (this.failing) throw new Error('D1 is away');
        const [key, today] = values as [string, string];
        const expiresAt = this.expiries.get(key);
        return expiresAt && expiresAt < today ? ({ gone: 1 } as T) : null;
      },
      all: async <T>(): Promise<{ results: T[] }> => ({ results: [] }),
    });
    return statement([]);
  }
}

class FakeUsage implements UsageSink {
  points: UsagePoint[] = [];
  async record(point: UsagePoint) {
    this.points.push(point);
  }
}

class FakeImages implements ImageTransformer {
  calls: TransformOptions[] = [];
  failures = 0;
  async transform(input: ReadableStream | ArrayBuffer, opts: TransformOptions) {
    if (input instanceof ReadableStream) await new Response(input).arrayBuffer();
    this.calls.push(opts);
    if (this.failures > 0) {
      this.failures -= 1;
      throw new TransformFailed('short body');
    }
    const body = new TextEncoder().encode(
      `resized:${opts.width}x${opts.height ?? 'auto'}:${opts.fit}`,
    ).buffer as ArrayBuffer;
    return { body, contentType: opts.format };
  }
}

function harness(
  opts: {
    images?: boolean;
    prefixes?: string[];
    menu?: typeof DEFAULT_MENU;
    embed?: EmbedPolicy | null;
    db?: Db | null;
    usage?: boolean;
    library?: string;
  } = {},
) {
  const source = new MemoryMediaSource();
  source.put('media/workshop/bench.jpg', png(), 'image/jpeg');
  source.put('media/products/Chair-01ABC.PNG', png(), 'image/png');
  source.put('private/secret.jpg', png(), 'image/jpeg');
  source.put('media/vector/logo.svg', png(), 'image/svg+xml');
  const images = new FakeImages();
  const usage = new FakeUsage();
  const app = createApp({
    source,
    images: opts.images === false ? null : images,
    prefixes: opts.prefixes ?? ['media/'],
    menu: opts.menu ?? DEFAULT_MENU,
    embed: opts.embed ?? null,
    db: opts.db ?? null,
    usage: opts.usage === false ? null : usage,
    library: opts.library ?? null,
  });
  const get = (path: string, headers: Record<string, string> = {}) =>
    app.request(`https://img.example.com${path}`, { headers });
  return { source, images, usage, get };
}

/** A row as the library would file it; only what the test names differs from the defaults. */
function file(
  db: SqliteDb,
  key: string,
  row: Partial<{
    subject: string | null;
    tags: string[];
    alt: string;
    credit: string | null;
    width: number | null;
    height: number | null;
    bytes: number | null;
    retired: boolean;
    capturedAt: string | null;
    camera: string | null;
    lens: string | null;
    originalWidth: number | null;
    focal: { x: number; y: number } | null;
  }> = {},
) {
  db.raw
    .prepare(
      `INSERT INTO assets (key, etag, sha256, bytes, content_type, width, height, subject, tags, alt_default, credit,
         source, first_seen, uploaded_by, filed_by, filed_at, retired, retired_note,
         captured_at, camera, lens, original_width, original_height, focal_x, focal_y)
       VALUES (?, 'etag', 'sha', ?, 'image/jpeg', ?, ?, ?, ?, ?, ?, 'upload', '2026-10-01T00:00:00.000Z',
         'someone@example.com', 'someone@example.com', '2026-10-02T00:00:00.000Z', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      key,
      row.bytes === undefined ? 12345 : row.bytes,
      row.width === undefined ? 1600 : row.width,
      row.height === undefined ? 1200 : row.height,
      row.subject === undefined ? 'workshop' : row.subject,
      JSON.stringify(row.tags ?? []),
      row.alt ?? '',
      row.credit === undefined ? null : row.credit,
      row.retired ? 1 : 0,
      row.retired ? 'duplicate' : null,
      row.capturedAt ?? null,
      row.camera ?? null,
      row.lens ?? null,
      row.originalWidth ?? null,
      row.originalWidth === undefined ? null : 4000,
      row.focal?.x ?? null,
      row.focal?.y ?? null,
    );
}

const json = async (res: Response) =>
  (await res.json()) as {
    ok: boolean;
    error?: { code: string; message: string };
    asset?: Record<string, unknown>;
    assets?: { key: string }[];
    cursor?: string | null;
  };

describe('served as stored', () => {
  it('serves objects under a served prefix and nothing else', async () => {
    const h = harness();
    const res = await h.get('/media/workshop/bench.jpg');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe(CACHE_STORED);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(png()));
    expect(h.images.calls).toHaveLength(0);

    expect((await h.get('/media/products/Chair-01ABC.PNG')).status).toBe(200);
    expect((await h.get('/private/secret.jpg')).status).toBe(404);
    expect((await h.get('/media/vector/logo.svg')).status).toBe(404);
    expect((await h.get('/media/missing.jpg')).status).toBe(404);
    expect((await h.get('/media/../private/secret.jpg')).status).toBe(404);
    expect((await h.get('/media/%2e%2e/private/secret.jpg')).status).toBe(404);
    expect((await h.get('/')).status).toBe(404);
  });

  it('serves a second prefix when configured', async () => {
    const h = harness({ prefixes: ['media/', 'private/'] });
    expect((await h.get('/private/secret.jpg')).status).toBe(200);
  });
});

describe('resized on request', () => {
  it('resizes to a menu width, scale-down by default, cover with an aspect ratio', async () => {
    const h = harness();
    const res = await h.get('/media/workshop/bench.jpg?w=768&f=webp');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cache-control')).toBe(CACHE_TRANSFORMED);
    expect(res.headers.get('vary')).toBe('Accept');
    expect(await res.text()).toBe('resized:768xauto:scale-down');
    expect(h.images.calls[0]).toEqual({ width: 768, fit: 'scale-down', format: 'image/webp' });

    const crop = await h.get('/media/workshop/bench.jpg?w=320&ar=4:3&f=jpeg');
    expect(await crop.text()).toBe('resized:320x240:cover');
  });

  it('negotiates the format on Accept with f=auto', async () => {
    const h = harness();
    const res = await h.get('/media/workshop/bench.jpg?w=320', { accept: 'image/avif,*/*' });
    expect(res.headers.get('content-type')).toBe('image/avif');
  });

  it('refuses parameters off the menu', async () => {
    const h = harness();
    const res = await h.get('/media/workshop/bench.jpg?w=999');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('BAD_MEDIA_PARAMS');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('honors a custom menu', async () => {
    const h = harness({ menu: menuFromLists('500', '2:1') });
    expect((await h.get('/media/workshop/bench.jpg?w=500&ar=2:1')).status).toBe(200);
    expect((await h.get('/media/workshop/bench.jpg?w=768')).status).toBe(400);
  });

  it('serves as stored without the binding, and says so', async () => {
    const h = harness({ images: false });
    const res = await h.get('/media/workshop/bench.jpg?w=320');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-media-transform')).toBe('unavailable');
    expect(res.headers.get('content-type')).toBe('image/jpeg');
  });

  it('serves a source over the binding cap as stored', async () => {
    const h = harness();
    h.source.put('media/big.jpg', new ArrayBuffer(MAX_TRANSFORM_SOURCE_BYTES + 1), 'image/jpeg');
    const res = await h.get('/media/big.jpg?w=320');
    expect(res.headers.get('x-media-transform')).toBe('too-large');
    expect(h.images.calls).toHaveLength(0);
  });

  it('retries one failed transform, and answers 502 after two', async () => {
    const h = harness();
    h.images.failures = 1;
    expect((await h.get('/media/workshop/bench.jpg?w=320')).status).toBe(200);
    h.images.failures = 2;
    const res = await h.get('/media/workshop/bench.jpg?w=480');
    expect(res.status).toBe(502);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('focal point', () => {
  const KEY = 'media/workshop/bench.jpg';
  const withFocal = () => {
    const db = new SqliteDb();
    file(db, KEY, { focal: { x: 0.3, y: 0.2 } });
    file(db, 'media/workshop/retired.jpg', { focal: { x: 0.9, y: 0.1 }, retired: true });
    return db;
  };

  it('crops around the library’s point, and leaves the rest of the crop alone', async () => {
    const h = harness({ db: withFocal() });
    const res = await h.get(`/${KEY}?w=320&ar=1:1&f=jpeg`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('resized:320x320:cover');
    expect(h.images.calls[0]).toEqual({
      width: 320,
      height: 320,
      fit: 'cover',
      format: 'image/jpeg',
      gravity: { x: 0.3, y: 0.2 },
    });
  });

  it('keeps a retired key’s point: it still serves wherever it is used', async () => {
    const h = harness({ db: withFocal() });
    h.source.put('media/workshop/retired.jpg', png(), 'image/jpeg');
    await h.get('/media/workshop/retired.jpg?w=320&ar=1:1');
    expect(h.images.calls[0]?.gravity).toEqual({ x: 0.9, y: 0.1 });
  });

  it('is automatic without a row, without a point, and never applies to scale-down', async () => {
    const db = withFocal();
    file(db, 'media/workshop/plain.jpg');
    const h = harness({ db });
    h.source.put('media/workshop/plain.jpg', png(), 'image/jpeg');
    await h.get('/media/workshop/plain.jpg?w=320&ar=1:1&f=jpeg');
    await h.get('/media/products/Chair-01ABC.PNG?w=320&ar=1:1&f=jpeg');
    await h.get(`/${KEY}?w=320&f=jpeg`);
    expect(h.images.calls).toEqual([
      { width: 320, height: 320, fit: 'cover', format: 'image/jpeg' },
      { width: 320, height: 320, fit: 'cover', format: 'image/jpeg' },
      { width: 320, fit: 'scale-down', format: 'image/jpeg' },
    ]);
  });

  it('is unchanged without the binding', async () => {
    const h = harness();
    await h.get(`/${KEY}?w=320&ar=1:1&f=jpeg`);
    expect(h.images.calls[0]).toEqual({
      width: 320,
      height: 320,
      fit: 'cover',
      format: 'image/jpeg',
    });
  });

  it('falls back to automatic when the database cannot answer', async () => {
    const broken = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            throw new Error('D1_ERROR: no such column');
          },
          all: async () => {
            throw new Error('D1_ERROR: no such column');
          },
        }),
      }),
    };
    const h = harness({ db: broken as unknown as SqliteDb });
    const res = await h.get(`/${KEY}?w=320&ar=1:1&f=jpeg`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('resized:320x320:cover');
    expect(h.images.calls[0]?.gravity).toBeUndefined();
  });

  it('reaches the Images binding as {x, y}, and as auto without a point', async () => {
    const seen: unknown[] = [];
    const output = () => ({
      response: () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'image/webp', 'content-length': '3' },
        }),
    });
    const binding = {
      input: () => ({
        transform: (t: unknown) => {
          seen.push(t);
          return { output };
        },
      }),
    };
    const images = new CloudflareImageTransformer(binding as unknown as ImagesBinding);
    const out = await images.transform(png(), {
      width: 320,
      height: 320,
      fit: 'cover',
      format: 'image/webp',
      gravity: { x: 0.3, y: 0.2 },
    });
    expect(out.contentType).toBe('image/webp');
    await images.transform(png(), { width: 320, fit: 'scale-down', format: 'image/webp' });
    expect(seen).toEqual([
      { width: 320, height: 320, fit: 'cover', gravity: { x: 0.3, y: 0.2 } },
      { width: 320, fit: 'scale-down', gravity: 'auto' },
    ]);
  });
});

describe('embedding allowlist', () => {
  const policy: EmbedPolicy = {
    allowed: ['www.example.com', '*.shop.example.com', 'localhost:8787'],
    allowEmptyReferer: true,
  };

  it('is open without a policy', async () => {
    const h = harness();
    const res = await h.get('/media/workshop/bench.jpg', { referer: 'https://evil.example.net/' });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('vary')).toBeNull();
  });

  it('serves allowed pages and echoes their origin', async () => {
    const h = harness({ embed: policy });
    const res = await h.get('/media/workshop/bench.jpg', {
      referer: 'https://www.example.com/catalog?page=2',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://www.example.com');
    expect(res.headers.get('vary')).toBe('Origin');

    const byOrigin = await h.get('/media/workshop/bench.jpg?w=320&f=webp', {
      origin: 'https://eu.shop.example.com',
    });
    expect(byOrigin.status).toBe(200);
    expect(byOrigin.headers.get('access-control-allow-origin')).toBe('https://eu.shop.example.com');
    expect(byOrigin.headers.get('vary')).toBe('Accept, Origin');

    expect(
      (await h.get('/media/workshop/bench.jpg', { referer: 'http://localhost:8787/' })).status,
    ).toBe(200);
  });

  it('refuses other sites with a 403 that is not cached', async () => {
    const h = harness({ embed: policy });
    const res = await h.get('/media/workshop/bench.jpg', { referer: 'https://evil.example.net/' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN_ORIGIN');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(h.images.calls).toHaveLength(0);

    // The bare domain is not covered by `*.shop.example.com`, and Origin wins over Referer.
    expect(
      (await h.get('/media/workshop/bench.jpg', { referer: 'https://shop.example.com/' })).status,
    ).toBe(403);
    expect(
      (
        await h.get('/media/workshop/bench.jpg', {
          origin: 'https://evil.example.net',
          referer: 'https://www.example.com/',
        })
      ).status,
    ).toBe(403);
    expect((await h.get('/media/workshop/bench.jpg', { referer: 'not a url' })).status).toBe(403);
  });

  it('lets a request with no Origin or Referer through unless told not to', async () => {
    const open = await harness({ embed: policy }).get('/media/workshop/bench.jpg');
    expect(open.status).toBe(200);
    expect(open.headers.get('access-control-allow-origin')).toBeNull();

    const strict = harness({ embed: { ...policy, allowEmptyReferer: false } });
    expect((await strict.get('/media/workshop/bench.jpg')).status).toBe(403);
    expect((await strict.get('/media/workshop/bench.jpg', { origin: 'null' })).status).toBe(403);
  });

  it('matches hosts exactly, by wildcard subdomain, and by port when given', () => {
    const u = (s: string) => new URL(s);
    expect(hostMatches(u('https://www.example.com/x'), 'www.example.com')).toBe(true);
    expect(hostMatches(u('https://www.example.com:8443/x'), 'www.example.com')).toBe(true);
    expect(hostMatches(u('https://example.com/'), 'www.example.com')).toBe(false);
    expect(hostMatches(u('https://a.b.example.com/'), '*.example.com')).toBe(true);
    expect(hostMatches(u('https://example.com/'), '*.example.com')).toBe(false);
    expect(hostMatches(u('https://notexample.com/'), '*.example.com')).toBe(false);
    expect(hostMatches(u('http://localhost:8787/'), 'localhost:8787')).toBe(true);
    expect(hostMatches(u('http://localhost:8788/'), 'localhost:8787')).toBe(false);
    expect(decideEmbed(new Request('https://img.example.com/x'), policy)).toEqual({
      allowed: true,
      origin: null,
    });
  });

  it('parses the variables and refuses malformed hosts', () => {
    expect(parseAllowedOrigins(undefined)).toBeNull();
    expect(parseAllowedOrigins(' ')).toBeNull();
    expect(parseAllowedOrigins('Example.com, *.example.com ,localhost:8787')).toEqual([
      'example.com',
      '*.example.com',
      'localhost:8787',
    ]);
    expect(() => parseAllowedOrigins('https://example.com')).toThrow();
    expect(() => parseAllowedOrigins('example.com/path')).toThrow();
    expect(() => parseAllowedOrigins('*example.com')).toThrow();
    expect(embedPolicyFromVars(undefined, 'false')).toBeNull();
    expect(embedPolicyFromVars('example.com', undefined)).toEqual({
      allowed: ['example.com'],
      allowEmptyReferer: true,
    });
    expect(embedPolicyFromVars('example.com', 'FALSE')?.allowEmptyReferer).toBe(false);
  });
});

describe('rights expiry', () => {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

  it('answers 410 EXPIRED for an expired key, as stored or resized, before any transform', async () => {
    const db = new FakeDb();
    db.expiries.set('media/workshop/bench.jpg', yesterday);
    const h = harness({ db });
    const stored = await h.get('/media/workshop/bench.jpg');
    expect(stored.status).toBe(410);
    expect(((await stored.json()) as { error: { code: string } }).error.code).toBe('EXPIRED');
    expect(stored.headers.get('cache-control')).toBe('no-store');
    const resized = await h.get('/media/workshop/bench.jpg?w=320&f=webp');
    expect(resized.status).toBe(410);
    expect(h.images.calls).toHaveLength(0);
  });

  it('still shows an expired file to the library, uncached, and to nobody else', async () => {
    const db = new FakeDb();
    db.expiries.set('media/workshop/bench.jpg', yesterday);
    const h = harness({ db, library: 'library.example.com' });
    const cached = new Map<string, Response>();
    const g = globalThis as { caches?: unknown };
    g.caches = {
      default: {
        match: async (req: Request) => cached.get(req.url)?.clone(),
        put: async (req: Request, res: Response) => {
          cached.set(req.url, res);
        },
      },
    };
    try {
      const page = { referer: 'https://library.example.com/library/file?key=x' };
      const stored = await h.get('/media/workshop/bench.jpg', page);
      expect(stored.status).toBe(200);
      expect(stored.headers.get('cache-control')).toBe(CACHE_STAFF_ONLY);
      const resized = await h.get('/media/workshop/bench.jpg?w=320&f=webp', page);
      expect(resized.status).toBe(200);
      expect(resized.headers.get('cache-control')).toBe(CACHE_STAFF_ONLY);
      // The Origin header names the page too, as a fetch from the library would.
      const fetched = await h.get('/media/workshop/bench.jpg?w=320&f=webp', {
        origin: 'https://library.example.com',
      });
      expect(fetched.status).toBe(200);
      // Nothing the library saw reached the shared cache, so the public still gets the 410.
      expect(cached.size).toBe(0);
      expect((await h.get('/media/workshop/bench.jpg')).status).toBe(410);
      expect((await h.get('/media/workshop/bench.jpg?w=320&f=webp')).status).toBe(410);
      const elsewhere = await h.get('/media/workshop/bench.jpg', {
        referer: 'https://www.example.com/page',
      });
      expect(elsewhere.status).toBe(410);
      expect((await h.get('/media/workshop/bench.jpg', { referer: 'not a url' })).status).toBe(410);
      // A live file from the library is cached as ever.
      db.expiries.set('media/products/Chair-01ABC.PNG', tomorrow);
      const live = await h.get('/media/products/Chair-01ABC.PNG?w=320&f=webp', page);
      expect(live.status).toBe(200);
      expect(live.headers.get('cache-control')).toBe(CACHE_TRANSFORMED);
      expect(cached.size).toBe(1);
    } finally {
      g.caches = undefined;
    }
    // Without the setting the library is nobody special.
    const plain = harness({ db });
    const refused = await plain.get('/media/workshop/bench.jpg', {
      referer: 'https://library.example.com/',
    });
    expect(refused.status).toBe(410);
  });

  it('reads the library host from its var and refuses a malformed one', () => {
    expect(libraryHostFromVar(undefined)).toBeNull();
    expect(libraryHostFromVar('  ')).toBeNull();
    expect(libraryHostFromVar('Library.Example.com')).toBe('library.example.com');
    expect(libraryHostFromVar('localhost:8787')).toBe('localhost:8787');
    expect(() => libraryHostFromVar('https://library.example.com')).toThrow(/Not a host/);
  });

  it('serves a key that expires today or later, or has no row', async () => {
    const db = new FakeDb();
    db.expiries.set('media/workshop/bench.jpg', tomorrow);
    db.expiries.set('media/products/Chair-01ABC.PNG', null);
    const h = harness({ db });
    expect((await h.get('/media/workshop/bench.jpg')).status).toBe(200);
    expect((await h.get('/media/workshop/bench.jpg?w=320')).status).toBe(200);
    expect((await h.get('/media/products/Chair-01ABC.PNG')).status).toBe(200);
    expect((await h.get('/media/missing.jpg')).status).toBe(404);
    expect(db.queries).toBe(4);
  });

  it('is not consulted without the binding, and fails open when the database errors', async () => {
    const h = harness();
    expect((await h.get('/media/workshop/bench.jpg')).status).toBe(200);
    const db = new FakeDb();
    db.expiries.set('media/workshop/bench.jpg', yesterday);
    db.failing = true;
    expect((await harness({ db }).get('/media/workshop/bench.jpg')).status).toBe(200);
  });

  it('compares the date as text against the day given', async () => {
    const db = new FakeDb();
    db.expiries.set('media/a.jpg', '2026-10-29');
    expect(await isExpired(db, 'media/a.jpg', '2026-10-30')).toBe(true);
    expect(await isExpired(db, 'media/a.jpg', '2026-10-29')).toBe(false);
    expect(await isExpired(db, 'media/b.jpg', '2026-10-30')).toBe(false);
  });
});

describe('masters are never served', () => {
  it('refuses masters/ before any prefix is consulted, as an image and in the API', async () => {
    const h = harness({ prefixes: ['media/', 'masters/'] });
    h.source.put('masters/psi/party.jpg', png(), 'image/jpeg');
    h.source.put('masters/psi/party.psd', png(), 'application/octet-stream');
    expect((await h.get('/masters/psi/party.jpg')).status).toBe(404);
    expect((await h.get('/masters/psi/party.psd')).status).toBe(404);
    expect((await h.get('/masters/psi/party.jpg?w=320')).status).toBe(404);
    expect(isServableKey('masters/psi/party.jpg', ['masters/'])).toBe(false);
    expect(isUnderPrefix('masters/psi/party.jpg', ['masters/'])).toBe(false);
    expect((await h.get('/api/v1/assets/masters/psi/party.jpg')).status).toBe(404);
    expect(parseListQuery(new URLSearchParams('prefix=masters/'), ['masters/']).kind).toBe('error');
    expect((await h.get('/media/workshop/bench.jpg')).status).toBe(200);
  });

  it('never lists masters, even when a configuration names them as a prefix', async () => {
    const db = new SqliteDb();
    file(db, 'media/workshop/bench.jpg');
    file(db, 'masters/workshop/bench.psd');
    // parsePrefixes would refuse this; the listing refuses it on its own too.
    const h = harness({ db, prefixes: ['media/', 'masters/'] });
    const body = await json(await h.get('/api/v1/assets'));
    expect(body.assets?.map((a) => a.key)).toEqual(['media/workshop/bench.jpg']);
    const only = harness({ db, prefixes: ['masters/'] });
    expect((await json(await only.get('/api/v1/assets'))).assets).toEqual([]);
  });
});

describe('metadata API', () => {
  const KEY = 'media/workshop/bench.jpg';
  const filed = () => {
    const db = new SqliteDb();
    file(db, KEY, {
      tags: ['hero', 'wood'],
      alt: 'A workbench under a window',
      credit: 'Studio',
    });
    file(db, 'media/workshop/old-bench.jpg', { retired: true });
    file(db, 'private/secret.jpg');
    return db;
  };

  it('answers 404 without the binding, and images are unaffected', async () => {
    const h = harness();
    const res = await h.get(`/api/v1/assets/${KEY}`);
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.error?.code).toBe('API_UNAVAILABLE');
    expect(body.error?.message).toMatch(/no metadata database/);
    expect((await h.get('/api/v1/assets')).status).toBe(404);
    expect((await json(await h.get('/api/v1/assets'))).error?.code).toBe('API_UNAVAILABLE');
    expect((await h.get(`/${KEY}`)).status).toBe(200);
  });

  it('returns what the library filed about a key, with CORS and cache headers', async () => {
    const h = harness({ db: filed() });
    const res = await h.get(`/api/v1/assets/${KEY}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe(CACHE_API);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await res.json()).toEqual({
      ok: true,
      asset: {
        key: KEY,
        bytes: 12345,
        contentType: 'image/jpeg',
        width: 1600,
        height: 1200,
        subject: 'workshop',
        tags: ['hero', 'wood'],
        alt: 'A workbench under a window',
        credit: 'Studio',
        title: null,
        creator: null,
        copyright: null,
        origin: null,
        firstSeen: '2026-10-01T00:00:00.000Z',
        capturedAt: null,
        camera: null,
        lens: null,
        originalWidth: null,
        originalHeight: null,
        focal: null,
      },
    });
  });

  it('serves the title, creator, copyright and origin, and never where the master is', async () => {
    const db = filed();
    db.raw
      .prepare(
        `UPDATE assets SET title = ?, creator = ?, copyright = ?, origin = ?, master_url = ?, master_name = ?
         WHERE key = ?`,
      )
      .run(
        'A workbench',
        'A. Joiner',
        '© 2026 A. Joiner',
        'Commissioned shoot',
        'https://drive.google.com/file/d/abc/view',
        'bench.psd',
        KEY,
      );
    const h = harness({ db });
    const body = await (await h.get(`/api/v1/assets/${KEY}`)).text();
    expect(JSON.parse(body).asset).toMatchObject({
      title: 'A workbench',
      creator: 'A. Joiner',
      copyright: '© 2026 A. Joiner',
      origin: 'Commissioned shoot',
    });
    expect(body).not.toContain('master');
    expect(body).not.toContain('drive.google.com');
    expect(body).not.toContain('bench.psd');
  });

  it('includes the capture data an upload recorded', async () => {
    const db = filed();
    file(db, 'media/workshop/lathe.jpg', {
      capturedAt: '2026-05-30T14:55:50',
      camera: 'NIKON Z 7',
      lens: 'NIKKOR Z 85mm f/1.8 S',
      originalWidth: 6000,
    });
    const h = harness({ db });
    expect(
      (await json(await h.get('/api/v1/assets/media/workshop/lathe.jpg'))).asset,
    ).toMatchObject({
      capturedAt: '2026-05-30T14:55:50',
      camera: 'NIKON Z 7',
      lens: 'NIKKOR Z 85mm f/1.8 S',
      originalWidth: 6000,
      originalHeight: 4000,
    });
  });

  it('carries the focal point, so a site can set object-position itself', async () => {
    const db = filed();
    file(db, 'media/workshop/portrait.jpg', { focal: { x: 0.42, y: 0.3 } });
    const h = harness({ db });
    const body = await json(await h.get('/api/v1/assets/media/workshop/portrait.jpg'));
    expect(body.asset?.focal).toEqual({ x: 0.42, y: 0.3 });
    const listed = await json(await h.get('/api/v1/assets?prefix=media%2Fworkshop%2Fp'));
    expect(listed.assets?.[0]).toMatchObject({ focal: { x: 0.42, y: 0.3 } });
  });

  it('ignores the embed allowlist: build tools send no Referer', async () => {
    const policy: EmbedPolicy = { allowed: ['www.example.com'], allowEmptyReferer: false };
    const h = harness({ db: filed(), embed: policy });
    const res = await h.get(`/api/v1/assets/${KEY}`, { referer: 'https://evil.example.net/' });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect((await h.get(`/${KEY}`, { referer: 'https://evil.example.net/' })).status).toBe(403);
  });

  it('does not find retired keys, unknown keys or keys outside the served prefixes', async () => {
    const h = harness({ db: filed() });
    for (const path of [
      '/api/v1/assets/media/workshop/old-bench.jpg',
      '/api/v1/assets/media/workshop/missing.jpg',
      '/api/v1/assets/private/secret.jpg',
      '/api/v1/assets/media/../private/secret.jpg',
      '/api/v1/assets/',
      '/api/v1/assets/%E0%A4%A',
    ]) {
      const res = await h.get(path);
      expect(res.status, path).toBe(404);
      expect((await json(res)).error?.code, path).toBe('NOT_FOUND');
    }
    // Retired keys still serve as images.
    h.source.put('media/workshop/old-bench.jpg', png(), 'image/jpeg');
    expect((await h.get('/media/workshop/old-bench.jpg')).status).toBe(200);
    expect((await h.get(`/api/v1/assets/${KEY}?v=2`)).status).toBe(400);
  });

  it('decodes keys with spaces and unicode the way mediaUrl encodes them', async () => {
    const db = filed();
    const key = 'media/workshop/café bench — 2.jpg';
    file(db, key, { alt: 'Café bench' });
    const h = harness({ db });
    const res = await h.get(assetUrl('', key));
    expect(res.status).toBe(200);
    expect((await json(res)).asset?.alt).toBe('Café bench');
  });

  it('lists assets in key order, filtered by prefix, subject and tag', async () => {
    const db = filed();
    file(db, 'media/products/chair.jpg', { subject: 'products', tags: ['hero', 'oak'] });
    file(db, 'media/products/table.jpg', { subject: 'products', tags: ['oak'] });
    file(db, 'media/products/stool.jpg', { subject: 'products', tags: [], retired: true });
    const h = harness({ db });
    const keys = async (path: string) => (await json(await h.get(path))).assets?.map((a) => a.key);

    const all = await h.get('/api/v1/assets');
    expect(all.status).toBe(200);
    expect(all.headers.get('cache-control')).toBe(CACHE_API);
    expect(all.headers.get('access-control-allow-origin')).toBe('*');
    expect(await json(all)).toMatchObject({ ok: true, cursor: null });
    expect(await keys('/api/v1/assets')).toEqual([
      'media/products/chair.jpg',
      'media/products/table.jpg',
      KEY,
    ]);
    expect(await keys('/api/v1/assets?prefix=media%2Fproducts%2F')).toEqual([
      'media/products/chair.jpg',
      'media/products/table.jpg',
    ]);
    expect(await keys('/api/v1/assets?subject=workshop')).toEqual([KEY]);
    expect(await keys('/api/v1/assets?tag=hero')).toEqual(['media/products/chair.jpg', KEY]);
    expect(
      await keys('/api/v1/assets?tag=oak&subject=products&prefix=media%2Fproducts%2Ft'),
    ).toEqual(['media/products/table.jpg']);
    expect(await keys('/api/v1/assets?tag=nothing')).toEqual([]);
  });

  it('lists every served prefix and nothing outside them', async () => {
    const db = filed();
    file(db, 'assets/web/logo.png', { subject: null });
    const h = harness({ db, prefixes: ['media/', 'assets/web/'] });
    const body = await json(await h.get('/api/v1/assets'));
    expect(body.assets?.map((a) => a.key)).toEqual(['assets/web/logo.png', KEY]);
  });

  it('pages with an opaque keyset cursor', async () => {
    const db = new SqliteDb();
    for (let i = 0; i < 5; i++) file(db, `media/workshop/shot-${i}.jpg`);
    const h = harness({ db });
    const first = await json(await h.get('/api/v1/assets?limit=2'));
    expect(first.assets?.map((a) => a.key)).toEqual([
      'media/workshop/shot-0.jpg',
      'media/workshop/shot-1.jpg',
    ]);
    expect(first.cursor).toBe(encodeCursor('media/workshop/shot-1.jpg'));
    const second = await json(
      await h.get(assetListUrl('', { limit: 2, cursor: first.cursor ?? '' })),
    );
    expect(second.assets?.map((a) => a.key)).toEqual([
      'media/workshop/shot-2.jpg',
      'media/workshop/shot-3.jpg',
    ]);
    const third = await json(await h.get(`/api/v1/assets?limit=2&cursor=${second.cursor}`));
    expect(third.assets?.map((a) => a.key)).toEqual(['media/workshop/shot-4.jpg']);
    expect(third.cursor).toBeNull();
    // Exactly a page's worth has no next page.
    expect((await json(await h.get('/api/v1/assets?limit=5'))).cursor).toBeNull();
  });

  it('refuses a prefix outside the served ones, a bad limit, a bad cursor and unknown parameters', async () => {
    const h = harness({ db: filed() });
    for (const q of [
      'prefix=private%2F',
      'prefix=media%2F..%2Fprivate%2F',
      'limit=0',
      'limit=501',
      'limit=ten',
      'cursor=not%20base64',
      'cursor=gA',
      'q=chair',
      // Characters a key may not hold, including the last code point, which has no successor.
      'prefix=media%2F%F4%8F%BF%BF',
      'prefix=media%2Fa%20b',
      'prefix=media%2F%27',
    ]) {
      const res = await h.get(`/api/v1/assets?${q}`);
      expect(res.status, q).toBe(400);
      const body = await json(res);
      expect(body.error?.code, q).toBe('BAD_REQUEST');
      expect(res.headers.get('cache-control')).toBe('no-store');
      // The answer names no configured prefix.
      expect(body.error?.message).not.toContain('media/');
    }
    expect((await h.get('/api/v1/assets?limit=500')).status).toBe(200);
  });

  it('does not describe a key whose rights have expired, retired yet or not', async () => {
    const db = filed();
    file(db, 'media/workshop/gone.jpg');
    file(db, 'media/workshop/soon.jpg');
    db.raw
      .prepare('UPDATE assets SET expires_at = ? WHERE key = ?')
      .run('2026-10-01', 'media/workshop/gone.jpg');
    db.raw
      .prepare('UPDATE assets SET expires_at = ? WHERE key = ?')
      .run('2099-01-01', 'media/workshop/soon.jpg');
    const h = harness({ db });
    expect((await h.get('/api/v1/assets/media/workshop/gone.jpg')).status).toBe(404);
    expect((await h.get('/api/v1/assets/media/workshop/soon.jpg')).status).toBe(200);
    const listed = (await json(await h.get('/api/v1/assets'))).assets?.map((a) => a.key);
    expect(listed).toContain('media/workshop/soon.jpg');
    expect(listed).toContain(KEY);
    expect(listed).not.toContain('media/workshop/gone.jpg');
    // The image route agrees: 410 for the same key.
    expect((await h.get('/media/workshop/gone.jpg')).status).toBe(410);
  });

  it('round-trips any key through the cursor', () => {
    for (const key of ['media/a.jpg', 'media/café bench — 2.jpg', 'media/\u{1F4F7}.jpg']) {
      expect(decodeCursor(encodeCursor(key))).toBe(key);
      expect(encodeCursor(key)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('a b')).toBeNull();
  });
});

describe('configuration', () => {
  it('parses served prefixes and refuses malformed ones', () => {
    expect(parsePrefixes(undefined)).toEqual(['media/']);
    expect(parsePrefixes('media/, assets/web/')).toEqual(['media/', 'assets/web/']);
    expect(() => parsePrefixes('media')).toThrow();
    expect(() => parsePrefixes('../x/')).toThrow();
    expect(() => parsePrefixes(' , ')).toThrow();
  });

  it('refuses the reserved folders as served prefixes', () => {
    expect(() => parsePrefixes('media/, masters/')).toThrow(/masters\/ is reserved/);
    expect(() => parsePrefixes('masters/psi/')).toThrow(/reserved/);
    expect(() => parsePrefixes('api/')).toThrow(/reserved/);
    expect(() => parsePrefixes('api/v1/')).toThrow(/reserved/);
    expect(() => parsePrefixes('healthz/')).toThrow(/reserved/);
    // A folder that merely starts with the same letters is fine.
    expect(parsePrefixes('mastersof/, apiary/')).toEqual(['mastersof/', 'apiary/']);
  });

  it('accepts only image keys under a prefix', () => {
    expect(isServableKey('media/a/b.jpg', ['media/'])).toBe(true);
    expect(isServableKey('media/a//b.jpg', ['media/'])).toBe(false);
    expect(isServableKey('media/a/b.html', ['media/'])).toBe(false);
    expect(isServableKey('mediax/b.jpg', ['media/'])).toBe(false);
  });
});

describe('usage', () => {
  it('counts a stored object and a transform, each with what went out', async () => {
    const h = harness();
    expect((await h.get('/media/workshop/bench.jpg')).status).toBe(200);
    expect((await h.get('/media/workshop/bench.jpg?w=768&f=webp')).status).toBe(200);
    expect(h.usage.points).toEqual([
      {
        key: 'media/workshop/bench.jpg',
        kind: 'stored',
        format: 'image/jpeg',
        cache: 'miss',
        bytes: png().byteLength,
      },
      {
        key: 'media/workshop/bench.jpg',
        kind: 'transform',
        format: 'webp',
        cache: 'miss',
        bytes: 'resized:768xauto:scale-down'.length,
      },
    ]);
  });

  it('counts a transform served as stored as what it was', async () => {
    const h = harness({ images: false });
    await h.get('/media/workshop/bench.jpg?w=320');
    expect(h.usage.points[0]).toMatchObject({ kind: 'stored', format: 'image/jpeg' });
  });

  it('counts nothing for a 404, a 400, a 403 or a 502', async () => {
    const h = harness({ embed: { allowed: ['www.example.com'], allowEmptyReferer: true } });
    expect((await h.get('/media/missing.jpg')).status).toBe(404);
    expect((await h.get('/media/workshop/bench.jpg?w=999')).status).toBe(400);
    expect(
      (await h.get('/media/workshop/bench.jpg', { referer: 'https://evil.example.net/' })).status,
    ).toBe(403);
    h.images.failures = 2;
    expect((await h.get('/media/workshop/bench.jpg?w=480')).status).toBe(502);
    expect(h.usage.points).toHaveLength(0);
  });

  it('serves as before without a sink', async () => {
    const h = harness({ usage: false });
    expect((await h.get('/media/workshop/bench.jpg')).status).toBe(200);
    expect((await h.get('/media/workshop/bench.jpg?w=320')).status).toBe(200);
  });

  it('counts an edge cache hit from the cached headers', async () => {
    const h = harness();
    const cached = new Map<string, Response>();
    const fakeCaches = {
      default: {
        match: async (req: Request) => cached.get(req.url)?.clone(),
        put: async (req: Request, res: Response) => {
          cached.set(req.url, res);
        },
      },
    };
    const g = globalThis as { caches?: unknown };
    g.caches = fakeCaches;
    try {
      await h.get('/media/workshop/bench.jpg?w=320&f=webp');
      await h.get('/media/workshop/bench.jpg?w=320&f=webp');
      await h.get('/media/workshop/bench.jpg');
      await h.get('/media/workshop/bench.jpg');
    } finally {
      g.caches = undefined;
    }
    expect(h.images.calls).toHaveLength(1);
    expect(h.usage.points.map((p) => `${p.kind}:${p.format}:${p.cache}:${p.bytes}`)).toEqual([
      'transform:webp:miss:27',
      'transform:webp:hit:27',
      'stored:image/jpeg:miss:11',
      'stored:image/jpeg:hit:11',
    ]);
  });

  it('writes one data point per hit to the binding, indexed by the key', async () => {
    const written: unknown[] = [];
    const sink = new AnalyticsEngineUsageSink({
      writeDataPoint: (event: unknown) => {
        written.push(event);
      },
    } as AnalyticsEngineDataset);
    await sink.record({
      key: 'media/a.jpg',
      kind: 'transform',
      format: 'avif',
      cache: 'miss',
      bytes: 1234,
    });
    await sink.record({
      key: 'media/b.jpg',
      kind: 'stored',
      format: 'image/png',
      cache: 'hit',
      bytes: null,
    });
    expect(written).toEqual([
      {
        indexes: ['media/a.jpg'],
        blobs: ['media/a.jpg', 'transform', 'avif', 'miss'],
        doubles: [1, 1234],
      },
      {
        indexes: ['media/b.jpg'],
        blobs: ['media/b.jpg', 'stored', 'image/png', 'hit'],
        doubles: [1],
      },
    ]);
  });
});

describe('the cache key and the library purge agree', () => {
  it('every request the menu allows is cached under a URL the purge lists, and nothing else', () => {
    const menu = menuFromLists('320,768', '1:1,16:9');
    const origin = 'https://img.example.com';
    const key = 'media/workshop/bench.jpg';
    const listed = new Set(variantUrls(origin, key, menu));
    const seen = new Set<string>();
    const accepts = ['image/avif,image/webp,*/*', 'image/webp,*/*', '*/*', null];
    for (const w of menu.widths) {
      for (const ar of [null, ...menu.aspects]) {
        for (const f of ['avif', 'webp', 'jpeg', 'auto', null]) {
          for (const accept of accepts) {
            // Parameters in an order the builder would not use, and the crop unencoded.
            const q = [f ? `f=${f}` : null, ar ? `ar=${ar}` : null, `w=${w}`].filter(Boolean);
            const url = new URL(`${origin}/${key}?${q.join('&')}`);
            const parsed = parseMediaParams(url, accept, menu);
            expect(parsed.kind).toBe('transform');
            if (parsed.kind !== 'transform') continue;
            const cacheKey = transformCacheKey(origin, key, parsed.params);
            expect(listed.has(cacheKey)).toBe(true);
            seen.add(cacheKey);
          }
        }
      }
    }
    // The stored object is cached under its bare URL, which the purge lists first.
    seen.add(storedCacheKey(origin, key));
    expect([...listed].sort()).toEqual([...seen].sort());
  });

  it('is built from the key and the parsed parameters, not from the request URL', () => {
    const origin = 'https://img.example.com';
    const key = 'media/workshop/bench.jpg';
    const canonical = `${origin}/media/workshop/bench.jpg?ar=16%3A9&f=webp&w=320`;
    for (const spelling of [
      '?w=320&ar=16:9&f=webp',
      '?f=webp&ar=16%3A9&w=320',
      '?ar=16:9&w=320&f=auto',
    ]) {
      const parsed = parseMediaParams(new URL(`${origin}/${key}${spelling}`), 'image/webp');
      expect(parsed.kind).toBe('transform');
      if (parsed.kind !== 'transform') continue;
      expect(transformCacheKey(origin, key, parsed.params)).toBe(canonical);
    }
    // A percent-encoded path decodes to the same key, so it shares the entry.
    expect(storedCacheKey(origin, key)).toBe(`${origin}/media/workshop/bench.jpg`);
    expect(variantUrls(origin, key)[0]).toBe(storedCacheKey(origin, key));
  });

  it('refuses every spelling of a width but the menu’s own, and a parameter given twice', async () => {
    const h = harness();
    for (const q of ['w=0320', 'w=00320', 'w=3.2e2', 'w=320.0', 'w=%2B320', 'w=%20320']) {
      const res = await h.get(`/media/workshop/bench.jpg?${q}`);
      expect(res.status, q).toBe(400);
      expect((await json(res)).error?.code).toBe('BAD_MEDIA_PARAMS');
    }
    for (const q of ['w=320&w=480', 'w=320&w=zzz', 'w=320&f=webp&f=webp', 'w=320&ar=1:1&ar=4:3']) {
      const res = await h.get(`/media/workshop/bench.jpg?${q}`);
      expect(res.status, q).toBe(400);
      expect((await json(res)).error?.message).toMatch(/more than once/);
    }
    expect((await h.get('/media/workshop/bench.jpg?w=320')).status).toBe(200);
    // A bare `?` is no query at all: the object as stored.
    const bare = await h.get('/media/workshop/bench.jpg?');
    expect(bare.status).toBe(200);
    expect(bare.headers.get('cache-control')).toBe(CACHE_STORED);
    // A percent-encoded path serves the same object.
    expect((await h.get('/media/workshop/%62ench.jpg?w=320')).status).toBe(200);
  });
});

describe('content type of a served object', () => {
  it('comes from the key when the stored type is not an image type', async () => {
    const h = harness();
    h.source.put('media/planted/page.jpg', png(), 'text/html');
    h.source.put('media/planted/vector.png', png(), 'image/svg+xml');
    h.source.put('media/planted/untyped.webp', png(), 'application/octet-stream');
    h.source.put('media/planted/real.jpg', png(), 'image/png');
    expect((await h.get('/media/planted/page.jpg')).headers.get('content-type')).toBe('image/jpeg');
    expect((await h.get('/media/planted/vector.png')).headers.get('content-type')).toBe(
      'image/png',
    );
    expect((await h.get('/media/planted/untyped.webp')).headers.get('content-type')).toBe(
      'image/webp',
    );
    // A stored image type other than SVG is kept even when it disagrees with the extension.
    expect((await h.get('/media/planted/real.jpg')).headers.get('content-type')).toBe('image/png');
    // The stored fallback of the transform route goes out the same way.
    const noImages = harness({ images: false });
    noImages.source.put('media/planted/page.jpg', png(), 'text/html');
    const res = await noImages.get('/media/planted/page.jpg?w=320');
    expect(res.headers.get('x-media-transform')).toBe('unavailable');
    expect(res.headers.get('content-type')).toBe('image/jpeg');
  });

  it('servedContentType trusts only image types, never SVG', () => {
    expect(servedContentType('media/a.jpg', 'text/html; charset=utf-8')).toBe('image/jpeg');
    expect(servedContentType('media/a.JPEG', null)).toBe('image/jpeg');
    expect(servedContentType('media/a.gif', 'image/svg+xml')).toBe('image/gif');
    expect(servedContentType('media/a.avif', 'IMAGE/AVIF')).toBe('image/avif');
    expect(servedContentType('media/a.webp', 'image/png')).toBe('image/png');
  });
});
