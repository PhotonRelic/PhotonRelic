/** /audit: every write, newest first, a hundred to a page. */
import { Hono } from 'hono';
import { type LibraryContext, page } from '../app.jsx';
import { recentActions } from '../audit.js';
import type { AppDeps } from '../deps.js';
import { AuditPage } from '../views/audit.jsx';

const PAGE = 100;

export function auditRoutes(deps: AppDeps) {
  const app = new Hono<LibraryContext>();
  app.get('/', async (c) => {
    const before = Number(c.req.query('before'));
    const entries = await recentActions(
      deps.db,
      PAGE,
      Number.isInteger(before) && before > 0 ? before : undefined,
    );
    const next = entries.length === PAGE ? (entries[entries.length - 1]?.id ?? null) : null;
    return page(c, deps, 'Audit', <AuditPage entries={entries} next={next} />);
  });
  return app;
}
