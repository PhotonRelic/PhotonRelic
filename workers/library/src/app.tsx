/**
 * The Hono app: Access identity on every request, a same-origin check on
 * every write, then the pages. Handlers stay thin; library.ts holds the SQL;
 * views hold the markup.
 */
import { type Context, Hono } from 'hono';
import type { Identity } from './access.js';
import type { AppDeps } from './deps.js';
import { type Flash, takeFlash } from './flash.js';
import { auditRoutes } from './handlers/audit.jsx';
import { libraryRoutes } from './handlers/library.jsx';
import { Layout, type PageProps } from './views/layout.jsx';

export interface Vars {
  identity: Identity;
}
export type LibraryContext = { Variables: Vars };
export type App = Hono<LibraryContext>;

/** Render a page inside the layout with the request's identity and flashes. */
export function page(
  c: Context<LibraryContext>,
  deps: AppDeps,
  title: string,
  body: PageProps['children'],
  extra: Partial<Pick<PageProps, 'modules'>> & { flashes?: Flash[] } = {},
): Response | Promise<Response> {
  const identity = c.get('identity');
  return c.html(
    <Layout
      title={title}
      path={new URL(c.req.url).pathname}
      identity={identity}
      environment={deps.environment}
      flashes={extra.flashes ?? takeFlash(c)}
      modules={extra.modules ?? []}
    >
      {body}
    </Layout>,
  );
}

/**
 * A write from another site is refused before it reaches a handler. Browsers
 * send Origin on every POST and PUT, and Sec-Fetch-Site on all of them now;
 * a request with neither (curl, a script holding an Access service token) is
 * not a browser being tricked and passes.
 */
export function crossSiteWrite(req: Request): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return false;
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) return true;
  const site = req.headers.get('sec-fetch-site');
  return site !== null && site !== 'same-origin' && site !== 'none';
}

export function createApp(deps: AppDeps): App {
  const app = new Hono<LibraryContext>();
  const imgSrc = ["'self'", 'data:', 'blob:', ...(deps.mediaOrigin ? [deps.mediaOrigin] : [])];
  // Alpine evaluates its attributes with Function, hence 'unsafe-eval'; the uploader
  // hashes in a Worker made from a blob URL.
  const csp = [
    "default-src 'self'",
    `img-src ${imgSrc.join(' ')}`,
    "script-src 'self' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
    // Master uploads go straight to R2 by presigned URL, so its endpoint is the one other origin.
    `connect-src 'self'${deps.masters ? ` ${deps.masters.origin}` : ''}`,
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

  app.get('/healthz', (c) => c.json({ ok: true, environment: deps.environment }));

  app.use('*', async (c, next) => {
    const identity = await deps.access.verify(c.req.raw);
    if (!identity) {
      return c.text('Unauthorized: a valid Cloudflare Access identity is required.', 401, {
        'cache-control': 'no-store',
      });
    }
    if (crossSiteWrite(c.req.raw)) {
      return c.text('Forbidden: cross-site request.', 403, { 'cache-control': 'no-store' });
    }
    c.set('identity', identity);
    await next();
    c.res.headers.set('cache-control', 'no-store');
    c.res.headers.set('x-frame-options', 'DENY');
    c.res.headers.set('x-content-type-options', 'nosniff');
    c.res.headers.set('referrer-policy', 'same-origin');
    if (c.res.headers.get('content-type')?.startsWith('text/html'))
      c.res.headers.set('content-security-policy', csp);
  });

  app.get('/', (c) => c.redirect('/library', 302));
  app.route('/library', libraryRoutes(deps));
  app.route('/audit', auditRoutes(deps));

  app.notFound((c) => {
    c.status(404);
    return page(c, deps, 'Not found', <p>No such page.</p>);
  });
  app.onError((err, c) => {
    console.error(
      JSON.stringify({ msg: 'unhandled', error: String(err), stack: err.stack, path: c.req.path }),
    );
    // Before the identity is set (the Access check itself failed) there is no layout to render.
    if (!c.get('identity'))
      return c.text(`Error: ${String(err)}`, 500, { 'cache-control': 'no-store' });
    c.status(500);
    return page(
      c,
      deps,
      'Error',
      <p class="flash flash-error">Something went wrong: {String(err)}</p>,
    );
  });
  return app;
}
