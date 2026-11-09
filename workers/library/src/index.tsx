/**
 * Worker entry. Builds the dependency set from the env once per isolate and
 * hands every request to the Hono app in app.tsx; the cron trigger runs the
 * expiry rule.
 */
import { menuFromLists } from '@photonrelic/media-params';
import { CloudflareAccessVerifier, LocalhostVerifier } from './access.js';
import { type App, createApp } from './app.jsx';
import type { AppDeps } from './deps.js';
import type { Env } from './env.js';
import { isoDate, retireExpired } from './library.js';
import { mastersFromVars } from './masters.js';
import { layoutFromVars, R2MediaBucket } from './media.js';
import { AnalyticsEngineUsage, usageConfigFromVars } from './usage.js';

export { createApp } from './app.jsx';
export type { AppDeps } from './deps.js';
export type { Env } from './env.js';

export function depsFromEnv(env: Env): AppDeps {
  // Without an Access audience the only way in is local development, which
  // declares itself with DEV_IDENTITY from .dev.vars, a file wrangler never
  // deploys, and is then answered on localhost only (LocalhostVerifier). A
  // deployed configuration with no audience therefore has no door at all,
  // whatever ENVIRONMENT says; ENVIRONMENT only labels the header.
  if (!env.ACCESS_AUD && !env.DEV_IDENTITY) {
    throw new Error(
      'ACCESS_AUD must be set; without Access, only local development with DEV_IDENTITY in .dev.vars may run',
    );
  }
  if (env.ACCESS_AUD && !env.ACCESS_TEAM_DOMAIN) {
    throw new Error('ACCESS_TEAM_DOMAIN must be set with ACCESS_AUD');
  }
  const access = env.ACCESS_AUD
    ? new CloudflareAccessVerifier(env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD)
    : new LocalhostVerifier({ email: env.DEV_IDENTITY as string, kind: 'user' });
  const usage = usageConfigFromVars(env.CF_ACCOUNT_ID, env.ANALYTICS_TOKEN, env.USAGE_DATASET);
  const mediaOrigin = env.MEDIA_ORIGIN ? env.MEDIA_ORIGIN.replace(/\/$/, '') : null;
  // Half a purge configuration is a deploy that meant to purge and will not: fail loudly.
  if (Boolean(env.CF_ZONE_ID) !== Boolean(env.CACHE_PURGE_TOKEN)) {
    throw new Error('CF_ZONE_ID and CACHE_PURGE_TOKEN must be set together');
  }
  if (env.CF_ZONE_ID && !mediaOrigin) {
    throw new Error('CF_ZONE_ID needs MEDIA_ORIGIN: there are no URLs to purge without it');
  }
  return {
    db: env.DB,
    access,
    media: env.MEDIA ? new R2MediaBucket(env.MEDIA) : null,
    layout: layoutFromVars(env.UPLOAD_PREFIX, env.LIBRARY_PREFIXES),
    mediaOrigin,
    usage: usage ? new AnalyticsEngineUsage(usage) : null,
    menu: menuFromLists(env.MEDIA_WIDTHS, env.MEDIA_ASPECTS),
    purge:
      env.CF_ZONE_ID && env.CACHE_PURGE_TOKEN
        ? {
            zoneId: env.CF_ZONE_ID,
            token: env.CACHE_PURGE_TOKEN,
            fetch: (url, init) => fetch(url, init),
          }
        : null,
    masters: mastersFromVars({
      accountId: env.CF_ACCOUNT_ID,
      bucket: env.MEDIA_BUCKET,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    }),
    environment: env.ENVIRONMENT,
    now: () => new Date(),
  };
}

const apps = new WeakMap<Env, App>();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let app = apps.get(env);
    if (!app) {
      app = createApp(depsFromEnv(env));
      apps.set(env, app);
    }
    return app.fetch(request, env, ctx);
  },

  /**
   * The daily expiry run (wrangler.toml `[triggers]`): retires every file
   * whose expiry date has passed, as of today in UTC. The same run is behind
   * the Expiring page's button, for an operator who will not wait for 03:00.
   */
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      retireExpired(env.DB, isoDate(new Date())).then((r) =>
        console.log(JSON.stringify({ msg: 'expiry run', today: r.today, retired: r.retired })),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
