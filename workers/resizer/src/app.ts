/**
 * GET /<key>: an object from the media bucket, as stored or resized on
 * request. Without parameters the object is served as stored; with ?w= (and
 * optionally ?ar= and ?f=) from the menu, the Images binding transforms it
 * and the edge cache keeps the output. A source over the binding's 20 MB
 * input cap, or an environment without the binding, is served as stored with
 * an `x-media-transform` header saying why.
 */
import {
  MAX_TRANSFORM_SOURCE_BYTES,
  MEDIA_MIME,
  type MediaTransformParams,
  parseMediaParams,
  type ResizeMenu,
} from '@photonrelic/media-params';
import { type Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { decideEmbed, type EmbedPolicy } from './embed.js';
import { type ImageTransformer, TransformFailed } from './images.js';
import { isServableKey, type MediaSource } from './source.js';

export interface ResizerDeps {
  source: MediaSource;
  images: ImageTransformer | null;
  prefixes: readonly string[];
  menu: ResizeMenu;
  /** Where images may be embedded from; null is open to every page. */
  embed: EmbedPolicy | null;
}

export const CACHE_STORED = 'public, max-age=86400';
/** Paths are not content-hashed, so transformed output is fresh for a day at the edge. */
export const CACHE_TRANSFORMED =
  'public, s-maxage=86400, max-age=3600, stale-while-revalidate=604800';

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
  | 'MEDIA_UNAVAILABLE'
  | 'FORBIDDEN_ORIGIN'
  | 'INTERNAL';

function apiError(c: Context, status: ContentfulStatusCode, code: ErrorCode, message: string) {
  return c.json({ ok: false as const, error: { code, message } }, status, {
    ...HEADERS,
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
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

  /** Serve an object as stored. */
  const serve = async (c: Context, key: string) => {
    const { cache, cacheKey } = cacheFor(new URL(c.req.url).toString());
    const hit = await cache?.match(cacheKey);
    if (hit) return hit;
    const object = await deps.source.get(key);
    if (!object) return apiError(c, 404, 'NOT_FOUND', 'No such media');
    const res = new Response(object.body, {
      status: 200,
      headers: {
        ...HEADERS,
        'content-type': object.contentType,
        'content-length': String(object.size),
        'cache-control': CACHE_STORED,
      },
    });
    if (cache) void background(c, cache.put(cacheKey, res.clone()));
    return res;
  };

  /** Serve an object resized; falls back to the stored object when it cannot be. */
  const serveTransformed = async (c: Context, key: string, params: MediaTransformParams) => {
    // The cache key carries the resolved format, so `f=auto` caches per format, not per Accept.
    const keyUrl = new URL(c.req.url);
    keyUrl.searchParams.set('f', params.resolved);
    keyUrl.searchParams.sort();
    const { cache, cacheKey } = cacheFor(keyUrl.toString());
    const hit = await cache?.match(cacheKey);
    if (hit) return hit;

    const object = await deps.source.get(key);
    if (!object) return apiError(c, 404, 'NOT_FOUND', 'No such media');

    const headers: Record<string, string> = {
      ...HEADERS,
      'cache-control': CACHE_TRANSFORMED,
      vary: 'Accept',
    };
    let res: Response;
    const images = deps.images;
    const reason = !images
      ? 'unavailable'
      : object.size > MAX_TRANSFORM_SOURCE_BYTES
        ? 'too-large'
        : null;
    if (reason || !images) {
      res = new Response(object.body, {
        status: 200,
        headers: {
          ...headers,
          'content-type': object.contentType,
          'content-length': String(object.size),
          'x-media-transform': reason ?? 'unavailable',
        },
      });
    } else {
      const opts: Parameters<typeof images.transform>[1] = {
        width: params.width,
        fit: params.fit,
        format: MEDIA_MIME[params.resolved],
      };
      if (params.height !== undefined) opts.height = params.height;
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
    }
    if (cache) void background(c, cache.put(cacheKey, res.clone()));
    return res;
  };

  app.get('/healthz', (c) => c.json({ ok: true }, 200, { 'cache-control': 'no-store' }));

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
