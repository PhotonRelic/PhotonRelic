/**
 * Worker entry. Builds the dependencies from the env once per isolate and
 * hands every request to the Hono app in app.ts.
 */
import { menuFromLists } from '@photonrelic/media-params';
import { createApp } from './app.js';
import { embedPolicyFromVars } from './embed.js';
import { CloudflareImageTransformer } from './images.js';
import { parsePrefixes, R2MediaSource } from './source.js';

export interface Env {
  /** The media bucket; read only. */
  MEDIA: R2Bucket;
  /** Cloudflare Images. Optional: without it, objects are served as stored. */
  IMAGES?: ImagesBinding;
  /** Comma-separated key prefixes to serve, each ending in `/`. Default `media/`. */
  SERVED_PREFIXES?: string;
  /** Comma-separated widths for ?w=; unset keeps the default menu. */
  MEDIA_WIDTHS?: string;
  /** Comma-separated aspect ratios (a:b) for ?ar=; unset keeps the default menu. */
  MEDIA_ASPECTS?: string;
  /** Comma-separated hosts that may embed images (`example.com`, `*.example.com`). Unset: any page. */
  ALLOWED_ORIGINS?: string;
  /** With ALLOWED_ORIGINS: "false" also refuses requests with no Origin or Referer. Default true. */
  ALLOW_EMPTY_REFERER?: string;
}

const apps = new WeakMap<Env, ReturnType<typeof createApp>>();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let app = apps.get(env);
    if (!app) {
      app = createApp({
        source: new R2MediaSource(env.MEDIA),
        images: env.IMAGES ? new CloudflareImageTransformer(env.IMAGES) : null,
        prefixes: parsePrefixes(env.SERVED_PREFIXES),
        menu: menuFromLists(env.MEDIA_WIDTHS, env.MEDIA_ASPECTS),
        embed: embedPolicyFromVars(env.ALLOWED_ORIGINS, env.ALLOW_EMPTY_REFERER),
      });
      apps.set(env, app);
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
