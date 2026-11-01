/**
 * Worker entry. Builds the dependency set from the env once per isolate and
 * hands every request to the Hono app in app.tsx.
 */
import { CloudflareAccessVerifier, FixedIdentityVerifier } from './access.js';
import { type App, createApp } from './app.jsx';
import type { AppDeps } from './deps.js';
import type { Env } from './env.js';
import { layoutFromVars, R2MediaBucket } from './media.js';

export { createApp } from './app.jsx';
export type { AppDeps } from './deps.js';
export type { Env } from './env.js';

export function depsFromEnv(env: Env): AppDeps {
  if (!env.ACCESS_AUD && env.ENVIRONMENT !== 'local') {
    throw new Error('ACCESS_AUD must be set outside local development');
  }
  if (env.ACCESS_AUD && !env.ACCESS_TEAM_DOMAIN) {
    throw new Error('ACCESS_TEAM_DOMAIN must be set with ACCESS_AUD');
  }
  const access = env.ACCESS_AUD
    ? new CloudflareAccessVerifier(env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD)
    : new FixedIdentityVerifier({ email: env.DEV_IDENTITY ?? 'dev@localhost', kind: 'user' });
  return {
    db: env.DB,
    access,
    media: env.MEDIA ? new R2MediaBucket(env.MEDIA) : null,
    layout: layoutFromVars(env.UPLOAD_PREFIX, env.LIBRARY_PREFIXES),
    mediaOrigin: env.MEDIA_ORIGIN ? env.MEDIA_ORIGIN.replace(/\/$/, '') : null,
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
} satisfies ExportedHandler<Env>;
