/**
 * GET /<key>: an object from the media bucket, as stored or resized on
 * request. Without parameters the object is served as stored; with ?w= (and
 * optionally ?ar= and ?f=) from the menu, the Images binding transforms it
 * and the edge cache keeps the output; a cover crop keeps the focal point the
 * library set for the key when the database is bound. A source over the
 * binding's 20 MB input cap, or an environment without the binding, is served
 * as stored with an `x-media-transform` header saying why. With the library's
 * database bound, a key whose rights have expired answers 410 on a cache miss.
 *
 * GET /api/v1/assets/<key> and GET /api/v1/assets: what the library filed
 * about a key (alt text, dimensions, credit, tags) as JSON, read from the
 * library's database when the resizer has the binding. Sites that embed
 * images cannot reach the library, which sits behind Access, so this is
 * their way to the metadata.
 */
import {
  MAX_TRANSFORM_SOURCE_BYTES,
  MEDIA_MIME,
  type MediaTransformParams,
  mediaUrl,
  parseMediaParams,
  type ResizeMenu,
  transformUrl,
} from '@photonrelic/media-params';
import { type Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getAsset, getFocal, isUnderPrefix, listAssets, parseListQuery } from './api.js';
import type { Db } from './db.js';
import { decideEmbed, type EmbedPolicy, pageIsOn } from './embed.js';
import { isExpired } from './expiry.js';
import { type ImageTransformer, TransformFailed } from './images.js';
import { isServableKey, type MediaSource, servedContentType } from './source.js';
import type { UsagePoint, UsageSink } from './usage.js';

export interface ResizerDeps {
  source: MediaSource;
  images: ImageTransformer | null;
  prefixes: readonly string[];
  menu: ResizeMenu;
  /** Where images may be embedded from; null is open to every page. */
  embed: EmbedPolicy | null;
  /**
   * The library's database, read only: the metadata API reads it, and a key
   * whose rights have expired answers 410. Null: the API answers
   * API_UNAVAILABLE and every key serves.
   */
  db: Db | null;
  /** Where each image served is counted; null counts nothing. */
  usage: UsageSink | null;
  /**
   * The library's own host. Its pages may still see a file whose rights have
   * expired, so the person renewing or retiring it knows what it is; null
   * means no such exception.
   */
  library: string | null;
}

export const CACHE_STORED = 'public, max-age=86400';
/** An expired file shown to the library: the browser may keep it, no shared cache may. */
export const CACHE_STAFF_ONLY = 'private, max-age=3600';
/** Paths are not content-hashed, so transformed output is fresh for a day at the edge. */
export const CACHE_TRANSFORMED =
  'public, s-maxage=86400, max-age=3600, stale-while-revalidate=604800';
/**
 * Metadata changes when someone files in the library, so the edge keeps it
 * for a minute only, and browsers not at all: a build fetching a thousand
 * keys in a loop is served from the edge, a page refreshed after filing sees
 * the new alt text within the minute.
 */
export const CACHE_API = 'public, s-maxage=60, max-age=0';

const ASSETS_PATH = '/api/v1/assets';

/**
 * Every response: no sniffing, no framing, no scripts; images are loaded by
 * other origins (a site, the library, an admin), so CORP is open. The CORS
 * header is added per request (see `withCors`), not cached.
 */
const HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'cross-origin-resource-policy': 'cross-origin',
};

type ErrorCode =
  | 'NOT_FOUND'
  | 'BAD_MEDIA_PARAMS'
  | 'BAD_REQUEST'
  | 'MEDIA_UNAVAILABLE'
  | 'API_UNAVAILABLE'
  | 'FORBIDDEN_ORIGIN'
  | 'EXPIRED'
  | 'INTERNAL';

function apiError(c: Context, status: ContentfulStatusCode, code: ErrorCode, message: string) {
  return c.json({ ok: false as const, error: { code, message } }, status, {
    ...HEADERS,
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
}

/**
 * The edge cache key for a resize: built from the validated key and the parsed
 * parameters, with `f` the format actually produced, never from the request
 * URL. So `f=auto` is cached per format, not per Accept header, and every
 * spelling of a request the menu accepts (parameter order, percent-encoding
 * in the path) lands on one entry. The library's purge after a replace or
 * delete enumerates these (`variantUrls` in media-params), so the two must
 * agree exactly; a test holds them together.
 */
export function transformCacheKey(
  origin: string,
  key: string,
  params: MediaTransformParams,
): string {
  return transformUrl(origin, key, params);
}

/** The edge cache key for the object as stored: its canonical URL, no query. */
export function storedCacheKey(origin: string, key: string): string {
  return mediaUrl(origin, key);
}

/** Run work after the response when the runtime allows it; await it otherwise (tests). */
function background(c: Context, work: Promise<unknown>): Promise<void> {
  const guarded = work.then(
    () => undefined,
    (e: unknown) => {
      console.error('background task failed', e instanceof Error ? e.message : e);
    },
  );
  try {
    c.executionCtx.waitUntil(guarded);
    return Promise.resolve();
  } catch {
    return guarded;
  }
}

/**
 * Access-Control-Allow-Origin for this request: `*` when the resizer is open,
 * the page's own origin when it is on the allowlist, nothing when the page is
 * unknown. Added after the cache, so a cached image never carries another
 * page's origin, and `Vary: Origin` tells browser caches the same.
 */
function withCors(res: Response, allowOrigin: string | null, open: boolean): Response {
  const out = new Response(res.body, res);
  if (open) {
    out.headers.set('access-control-allow-origin', '*');
  } else {
    if (allowOrigin) out.headers.set('access-control-allow-origin', allowOrigin);
    out.headers.append('vary', 'Origin');
  }
  return out;
}

export function createApp(deps: ResizerDeps) {
  const app = new Hono();

  const cacheFor = (keyUrl: string) => {
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    return { cache, cacheKey: new Request(keyUrl, { method: 'GET' }) };
  };

  /**
   * Whether a key's rights have run out, and what that means for this
   * request: `live` serves and caches as usual; `staff` serves because the
   * page is the library's own, but never through the shared cache, so a
   * staff view can never become a public hit; a Response is the 410.
   * Asked on a cache miss only, so a copy already at the edge serves out its
   * day; the 410 itself is not cached, so a new date takes effect at once.
   * The library's identity is its Referer, which is a publishing control,
   * not a security boundary: the file was public until the date passed.
   */
  const expiry = async (c: Context, key: string): Promise<'live' | 'staff' | Response> => {
    if (!deps.db || !(await isExpired(deps.db, key))) return 'live';
    if (deps.library && pageIsOn(c.req.raw, deps.library)) return 'staff';
    return apiError(c, 410, 'EXPIRED', 'The rights to this image have expired');
  };
  /** Count one image served, after the response; only 200s reach here. */
  const note = (c: Context, point: UsagePoint) => {
    if (deps.usage) void background(c, deps.usage.record(point));
  };
  /** The point for a response the edge cache answered; the headers say what was served. */
  const notedHit = (c: Context, key: string, hit: Response, resolved: string | null) => {
    const length = Number(hit.headers.get('content-length'));
    const contentType = hit.headers.get('content-type') ?? 'application/octet-stream';
    const transformed = resolved !== null && !hit.headers.has('x-media-transform');
    note(c, {
      key,
      kind: transformed ? 'transform' : 'stored',
      format: transformed ? resolved : contentType,
      cache: 'hit',
      bytes: Number.isFinite(length) && length > 0 ? length : null,
    });
    return hit;
  };

  /** Serve an object as stored. */
  const serve = async (c: Context, key: string) => {
    const { cache, cacheKey } = cacheFor(storedCacheKey(new URL(c.req.url).origin, key));
    const hit = await cache?.match(cacheKey);
    if (hit) return notedHit(c, key, hit, null);
    const state = await expiry(c, key);
    if (state instanceof Response) return state;
    const object = await deps.source.get(key);
    if (!object) return apiError(c, 404, 'NOT_FOUND', 'No such media');
    const contentType = servedContentType(key, object.contentType);
    const res = new Response(object.body, {
      status: 200,
      headers: {
        ...HEADERS,
        'content-type': contentType,
        'content-length': String(object.size),
        'cache-control': state === 'live' ? CACHE_STORED : CACHE_STAFF_ONLY,
      },
    });
    if (cache && state === 'live') void background(c, cache.put(cacheKey, res.clone()));
    note(c, { key, kind: 'stored', format: contentType, cache: 'miss', bytes: object.size });
    return res;
  };

  /** Serve an object resized; falls back to the stored object when it cannot be. */
  const serveTransformed = async (c: Context, key: string, params: MediaTransformParams) => {
    const { cache, cacheKey } = cacheFor(transformCacheKey(new URL(c.req.url).origin, key, params));
    const hit = await cache?.match(cacheKey);
    if (hit) return notedHit(c, key, hit, params.resolved);
    const state = await expiry(c, key);
    if (state instanceof Response) return state;

    const object = await deps.source.get(key);
    if (!object) return apiError(c, 404, 'NOT_FOUND', 'No such media');

    const headers: Record<string, string> = {
      ...HEADERS,
      'cache-control': state === 'live' ? CACHE_TRANSFORMED : CACHE_STAFF_ONLY,
      vary: 'Accept',
    };
    let res: Response;
    let point: UsagePoint;
    const images = deps.images;
    const reason = !images
      ? 'unavailable'
      : object.size > MAX_TRANSFORM_SOURCE_BYTES
        ? 'too-large'
        : null;
    if (reason || !images) {
      const contentType = servedContentType(key, object.contentType);
      res = new Response(object.body, {
        status: 200,
        headers: {
          ...headers,
          'content-type': contentType,
          'content-length': String(object.size),
          'x-media-transform': reason ?? 'unavailable',
        },
      });
      // What went out is the stored object, so it is counted as one.
      point = {
        key,
        kind: 'stored',
        format: contentType,
        cache: 'miss',
        bytes: object.size,
      };
    } else {
      const opts: Parameters<typeof images.transform>[1] = {
        width: params.width,
        fit: params.fit,
        format: MEDIA_MIME[params.resolved],
      };
      if (params.height !== undefined) opts.height = params.height;
      // A cover crop keeps the library's focal point when the database is
      // bound: one read, on the cold path only, since the cached output has
      // the crop baked in. A database that cannot answer is not a reason to
      // fail an image: the crop falls back to auto and the error is logged,
      // as the API's absence is a 404 rather than a broken deployment.
      if (params.fit === 'cover' && deps.db) {
        try {
          const focal = await getFocal(deps.db, key);
          if (focal) opts.gravity = focal;
        } catch (e) {
          console.error('focal point read failed', key, e instanceof Error ? e.message : e);
        }
      }
      // One retry on a fresh read of the object covers a binding hiccup; a
      // second failure answers 502 uncached so the next request tries again
      // rather than caching a short body that shows as a broken image.
      let out: Awaited<ReturnType<typeof images.transform>>;
      try {
        out = await images.transform(object.body, opts);
      } catch (first) {
        if (!(first instanceof TransformFailed)) throw first;
        console.warn('media transform retry', key, first.message);
        const again = await deps.source.get(key);
        if (!again) return apiError(c, 404, 'NOT_FOUND', 'No such media');
        try {
          out = await images.transform(again.body, opts);
        } catch (second) {
          if (!(second instanceof TransformFailed)) throw second;
          console.error('media transform failed twice', key, second.message);
          return apiError(c, 502, 'MEDIA_UNAVAILABLE', 'The resizer did not deliver a whole image');
        }
      }
      res = new Response(out.body, {
        status: 200,
        headers: {
          ...headers,
          'content-type': out.contentType,
          'content-length': String(out.body.byteLength),
        },
      });
      point = {
        key,
        kind: 'transform',
        format: params.resolved,
        cache: 'miss',
        bytes: out.body.byteLength,
      };
    }
    if (cache && state === 'live') void background(c, cache.put(cacheKey, res.clone()));
    note(c, point);
    return res;
  };

  /**
   * A JSON answer from the metadata API, kept at the edge under the full URL
   * like the image routes. CORS is `*` whatever ALLOWED_ORIGINS says: the
   * embed policy judges pages by their Referer, and a build tool sends none;
   * the answer is the same for everyone and holds nothing the library would
   * not put in a page's alt attribute anyway.
   */
  const serveApi = async (c: Context, read: () => Promise<unknown | null>) => {
    const { cache, cacheKey } = cacheFor(new URL(c.req.url).toString());
    const hit = await cache?.match(cacheKey);
    if (hit) return hit;
    const body = await read();
    if (body === null) return apiError(c, 404, 'NOT_FOUND', 'No such asset');
    const res = new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        ...HEADERS,
        'access-control-allow-origin': '*',
        'content-type': 'application/json',
        'cache-control': CACHE_API,
      },
    });
    if (cache) void background(c, cache.put(cacheKey, res.clone()));
    return res;
  };

  const apiUnavailable = (c: Context) =>
    apiError(c, 404, 'API_UNAVAILABLE', 'This deployment has no metadata database');

  app.get('/healthz', (c) => c.json({ ok: true }, 200, { 'cache-control': 'no-store' }));

  // The API routes come before the catch-all, so `api/` must not be a served prefix.
  app.get(ASSETS_PATH, async (c) => {
    const db = deps.db;
    if (!db) return apiUnavailable(c);
    const parsed = parseListQuery(new URL(c.req.url).searchParams, deps.prefixes);
    if (parsed.kind === 'error') return apiError(c, 400, 'BAD_REQUEST', parsed.message);
    return serveApi(c, async () => ({
      ok: true,
      ...(await listAssets(db, parsed.query, deps.prefixes)),
    }));
  });

  app.get(`${ASSETS_PATH}/*`, async (c) => {
    const db = deps.db;
    if (!db) return apiUnavailable(c);
    const url = new URL(c.req.url);
    if (url.search) return apiError(c, 400, 'BAD_REQUEST', 'This route takes no parameters');
    // Decoded the same way as the image route: the path is the key, encoded per segment.
    let key: string;
    try {
      key = decodeURIComponent(url.pathname.slice(ASSETS_PATH.length + 1));
    } catch {
      return apiError(c, 404, 'NOT_FOUND', 'No such asset');
    }
    if (!isUnderPrefix(key, deps.prefixes)) return apiError(c, 404, 'NOT_FOUND', 'No such asset');
    return serveApi(c, async () => {
      const asset = await getAsset(db, key);
      return asset ? { ok: true, asset } : null;
    });
  });

  app.get('/*', async (c) => {
    let allowOrigin: string | null = null;
    if (deps.embed) {
      const decision = decideEmbed(c.req.raw, deps.embed);
      if (!decision.allowed) {
        return apiError(
          c,
          403,
          'FORBIDDEN_ORIGIN',
          decision.reason === 'no-referer'
            ? 'This image can only be embedded from an allowed site'
            : 'This site may not embed this image',
        );
      }
      allowOrigin = decision.origin;
    }

    const url = new URL(c.req.url);
    let key: string;
    try {
      key = decodeURIComponent(url.pathname.slice(1));
    } catch {
      return apiError(c, 404, 'NOT_FOUND', 'No such media');
    }
    if (!isServableKey(key, deps.prefixes)) return apiError(c, 404, 'NOT_FOUND', 'No such media');

    const parsed = parseMediaParams(url, c.req.header('accept') ?? null, deps.menu);
    if (parsed.kind === 'error') return apiError(c, 400, 'BAD_MEDIA_PARAMS', parsed.message);
    const res =
      parsed.kind === 'transform'
        ? await serveTransformed(c, key, parsed.params)
        : await serve(c, key);
    return withCors(res, allowOrigin, deps.embed === null);
  });

  app.notFound((c) => apiError(c, 404, 'NOT_FOUND', 'No such media'));
  app.onError((err, c) => {
    console.error('unhandled error', err instanceof Error ? (err.stack ?? err.message) : err);
    return apiError(c, 500, 'INTERNAL', 'Something went wrong');
  });
  return app;
}
