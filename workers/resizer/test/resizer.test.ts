import { DEFAULT_MENU, MAX_TRANSFORM_SOURCE_BYTES, menuFromLists } from '@photonrelic/media-params';
import { describe, expect, it } from 'vitest';
import { CACHE_STORED, CACHE_TRANSFORMED, createApp } from '../src/app.js';
import {
  decideEmbed,
  type EmbedPolicy,
  embedPolicyFromVars,
  hostMatches,
  parseAllowedOrigins,
} from '../src/embed.js';
import { type ExpiryDb, isExpired } from '../src/expiry.js';
import { type ImageTransformer, TransformFailed, type TransformOptions } from '../src/images.js';
import { isServableKey, MemoryMediaSource, parsePrefixes } from '../src/source.js';
import { AnalyticsEngineUsageSink, type UsagePoint, type UsageSink } from '../src/usage.js';

/** The first bytes of a PNG, enough to be a distinct stored object. */
const png = () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).buffer as ArrayBuffer;

/** The library's `assets` table, reduced to key and expiry, answering the one query the resizer makes. */
class FakeDb implements ExpiryDb {
  readonly expiries = new Map<string, string | null>();
  queries = 0;
  failing = false;
  prepare(_sql: string) {
    return {
      bind: (...values: unknown[]) => ({
        first: async <T>(): Promise<T | null> => {
          this.queries += 1;
          if (this.failing) throw new Error('D1 is away');
          const [key, today] = values as [string, string];
          const expiresAt = this.expiries.get(key);
          return expiresAt && expiresAt < today ? ({ gone: 1 } as T) : null;
        },
      }),
    };
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
    db?: FakeDb;
    usage?: boolean;
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
  });
  const get = (path: string, headers: Record<string, string> = {}) =>
    app.request(`https://img.example.com${path}`, { headers });
  return { source, images, usage, get };
}

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

  it('honours a custom menu', async () => {
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
      referer: 'https://www.example.com/catalogue?page=2',
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

describe('configuration', () => {
  it('parses served prefixes and refuses malformed ones', () => {
    expect(parsePrefixes(undefined)).toEqual(['media/']);
    expect(parsePrefixes('media/, assets/web/')).toEqual(['media/', 'assets/web/']);
    expect(() => parsePrefixes('media')).toThrow();
    expect(() => parsePrefixes('../x/')).toThrow();
    expect(() => parsePrefixes(' , ')).toThrow();
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
