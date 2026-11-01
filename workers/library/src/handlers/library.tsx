/**
 * The media library's pages and writes, mounted under /library: the
 * bucket-first browser, one file, bulk filing, the upload page with its
 * precheck and streamed PUT, duplicates, the unfiled queue, the expiring
 * view with its run-now control, Rescan, and the two doors that change an
 * object in place: the file page's Replace (new bytes under the same key)
 * and Delete, each confirmed by the person pressing it. Both purge the edge
 * afterwards when a purge is configured.
 */
import { variantUrls } from '@photonrelic/media-params';
import { Hono } from 'hono';
import { type LibraryContext, page } from '../app.jsx';
import { logAction } from '../audit.js';
import { type AppDeps, previewUrl, publicUrl } from '../deps.js';
import { redirectWith, setFlash } from '../flash.js';
import {
  type Asset,
  checkRights,
  countDuplicateKeys,
  countExpiring,
  countUnfiled,
  fileAssets,
  forgetAsset,
  getAsset,
  getAssets,
  IMAGE_KEY,
  isoDate,
  knownSha256,
  listActive,
  listDuplicates,
  listExpiring,
  listUnfiled,
  type PrecheckEntry,
  parseCaptureHeader,
  parseTags,
  precheck,
  recordReplace,
  recordUpload,
  replacePrecheck,
  rescan,
  retireAsset,
  retireExpired,
  SEARCH_STATES,
  type SearchFilters,
  searchAssets,
  searchFacets,
  TOO_BIG,
} from '../library.js';
import { markupPanel } from '../markup.js';
import {
  contentTypeFor,
  isLibraryKey,
  type MediaBucket,
  type MediaObject,
  sha256Hex,
  sniffImageType,
  UPLOAD_MAX_BYTES,
  UPLOAD_SOURCE_TAG,
  uploadKeyPattern,
  WEB_IMAGE_KEY,
} from '../media.js';
import { type PurgeResult, purgeUrls } from '../purge.js';
import { USAGE_RETENTION_DAYS } from '../usage.js';
import {
  BrowsePage,
  type BulkPreview,
  BulkPreviewPage,
  DuplicatesPage,
  ExpiringPage,
  FilePage,
  type LibraryStats,
  type Preview,
  SearchPage,
  type Tile,
  UnfiledPage,
  UnusedPage,
  UploadPage,
  type UsageStatus,
} from '../views/library.jsx';

/** Unused files to a page; the whole set is computed, this is how much is shown at once. */
const UNUSED_PAGE = 100;

const SAFE_BACK = /^\/library(?:[/?#][^\s]*)?$/;
const NO_STORE = 'No media bucket is bound to this Worker.';
/** Tiles to a page of search results. */
const SEARCH_PAGE = 60;
/** Longer than any query a person types; keeps a pasted blob out of the index's parser. */
const SEARCH_QUERY_MAX = 200;

export function libraryRoutes(deps: AppDeps) {
  const app = new Hono<LibraryContext>();
  const { layout } = deps;
  const uploadPattern = uploadKeyPattern(layout);
  const preview: Preview = (key, width) => previewUrl(deps, key, width);
  const actor = (c: { get: (k: 'identity') => { email: string } }) => c.get('identity').email;
  const str = (f: Record<string, unknown>, k: string, d = '') =>
    typeof f[k] === 'string' ? (f[k] as string) : d;
  const many = (f: Record<string, unknown>, k: string): string[] => {
    const v = f[k];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
    return typeof v === 'string' ? [v] : [];
  };
  const backOf = (raw: string) => (SAFE_BACK.test(raw) ? raw : '/library');
  const fileBack = (key: string) => `/library/file?key=${encodeURIComponent(key)}`;
  /** The library page for the folder a key sits in. */
  const folderOf = (key: string) =>
    `/library?prefix=${encodeURIComponent(key.slice(0, key.lastIndexOf('/') + 1))}`;
  const cleanSubject = (s: string) => s.trim().replace(/^\/+|\/+$/g, '');
  /** The calendar date expiry is judged against, from the deps' clock. */
  const today = () => isoDate(deps.now());

  /** What a save changed, by field, for the audit row. */
  const EDITABLE = [
    'subject',
    'tags',
    'alt_default',
    'credit',
    'licence',
    'source_url',
    'restrictions',
    'expires_at',
  ] as const;
  function changedFields(before: Asset | null, after: Asset | null): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of EDITABLE) {
      const was = before?.[f] ?? null;
      const now = after?.[f] ?? null;
      if (JSON.stringify(was) !== JSON.stringify(now)) out[f] = now;
    }
    return out;
  }

  /** A prefix the library lists: '' (the roots) or under one of the roots, no traversal. */
  function libraryPrefix(requested: string | undefined): string | null {
    if (!requested) return '';
    if (requested.includes('..')) return null;
    const p = requested.endsWith('/') ? requested : `${requested}/`;
    return layout.libraryPrefixes.some((root) => p.startsWith(root)) ? p : null;
  }

  async function tilesFor(objects: MediaObject[]): Promise<Tile[]> {
    const images = objects.filter((o) => IMAGE_KEY.test(o.key));
    const assets = await getAssets(
      deps.db,
      images.map((o) => o.key),
    );
    return images.map((object) => ({ object, asset: assets.get(object.key) }));
  }

  async function stats(): Promise<LibraryStats> {
    const [unfiled, duplicateKeys, expiring] = await Promise.all([
      countUnfiled(deps.db),
      countDuplicateKeys(deps.db),
      countExpiring(deps.db, today()),
    ]);
    return { unfiled, duplicateKeys, expiring };
  }

  /** One key's hit counts for the file page. The engine being down costs a line, not the page. */
  async function usageOf(key: string): Promise<UsageStatus> {
    if (!deps.usage) return { state: 'off' };
    try {
      const counts = (await deps.usage.usageFor([key])).get(key) ?? { d7: 0, d30: 0 };
      return { state: 'ok', counts };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(JSON.stringify({ msg: 'usage lookup failed', key, error: message }));
      return { state: 'error', message };
    }
  }

  // Purge ---------------------------------------------------------------------
  /**
   * Drop every copy the edge may hold of these keys: the stored object and each
   * size on the menu. Awaited rather than left to run after the response, so the
   * page the person lands on next is fetched after the edge has let go, and the
   * flash can say truthfully whether it did. A failure is a line in the audit
   * log and in the flash, never an error page: the write already happened.
   */
  /** Changed keys a Rescan purges within its own request: five API calls each. */
  const RESCAN_PURGE_KEYS = 8;

  async function purgeKeys(who: string, keys: string[]): Promise<PurgeResult> {
    const origin = deps.mediaOrigin;
    const urls = origin ? keys.flatMap((k) => variantUrls(origin, k, deps.menu)) : [];
    const r = await purgeUrls(deps.purge, urls);
    if (r.error !== null)
      await logAction(deps.db, {
        actor: who,
        action: 'library.purge',
        detail: { keys, urls: urls.length, purged: r.urls, error: r.error },
        ok: false,
      });
    return r;
  }

  /** The end of a flash after a write that changed what the edge serves. */
  const purgeNote = (r: PurgeResult): string =>
    !r.configured
      ? 'Cached copies refresh within a day.'
      : r.error === null
        ? 'Cached copies purged.'
        : `The purge failed (${r.error}); cached copies refresh within a day.`;

  // Browse ----------------------------------------------------------------
  app.get('/', async (c) => {
    const prefix = libraryPrefix(c.req.query('prefix'));
    if (prefix === null) return c.redirect('/library', 302);
    const cursor = c.req.query('cursor') || undefined;
    let prefixes: string[] = [];
    let tiles: Tile[] = [];
    let next: string | null = null;
    let error: string | null = null;
    if (!deps.media) error = NO_STORE;
    else if (prefix === '') {
      // The roots themselves: one folder per listed prefix, whether or not it holds anything yet.
      prefixes = [...layout.libraryPrefixes];
    } else {
      try {
        const listing = await deps.media.list(prefix, {
          delimiter: '/',
          ...(cursor ? { cursor } : {}),
        });
        prefixes = listing.prefixes;
        tiles = await tilesFor(listing.objects);
        next = listing.cursor;
      } catch (e) {
        error = `Could not list the bucket: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    return page(
      c,
      deps,
      'Library',
      <BrowsePage
        prefix={prefix}
        prefixes={prefixes}
        tiles={tiles}
        cursor={next}
        stats={await stats()}
        preview={preview}
        error={error}
      />,
    );
  });

  // Search -----------------------------------------------------------------
  // Over the rows the library knows, so a file dropped in the bucket outside the
  // library is found once a Rescan has noted it. Reads nothing from the bucket.
  app.get('/search', async (c) => {
    const requested = c.req.query('state');
    const filters: SearchFilters = {
      q: (c.req.query('q') ?? '').trim().slice(0, SEARCH_QUERY_MAX),
      subject: cleanSubject(c.req.query('subject') ?? '') || null,
      tag: parseTags(c.req.query('tag') ?? '')[0] ?? null,
      camera: (c.req.query('camera') ?? '').trim().slice(0, SEARCH_QUERY_MAX) || null,
      state: SEARCH_STATES.find((s) => s === requested) ?? 'all',
    };
    const pageNo = Math.max(1, Math.floor(Number(c.req.query('page')) || 1));
    const [found, facets] = await Promise.all([
      searchAssets(deps.db, filters, SEARCH_PAGE, (pageNo - 1) * SEARCH_PAGE),
      searchFacets(deps.db, filters),
    ]);
    // The grid wants a listing entry per tile; the row has what the listing would say.
    const tiles: Tile[] = found.assets.map((a) => ({
      object: { key: a.key, size: a.bytes ?? 0, uploaded: a.first_seen, etag: a.etag },
      asset: a,
    }));
    return page(
      c,
      deps,
      filters.q ? `Search: ${filters.q}` : 'Search',
      <SearchPage
        filters={filters}
        page={pageNo}
        pageSize={SEARCH_PAGE}
        total={found.total}
        tiles={tiles}
        facets={facets}
        preview={preview}
      />,
    );
  });

  /** The original object, streamed through this Worker: previews when no resizer is configured. */
  app.get('/raw', async (c) => {
    const key = c.req.query('key') ?? '';
    if (!deps.media || !isLibraryKey(layout, key) || !IMAGE_KEY.test(key)) return c.notFound();
    const o = await deps.media.get(key);
    if (!o) return c.notFound();
    return new Response(o.body, {
      headers: { 'content-type': o.contentType, 'content-length': String(o.size) },
    });
  });

  // One file --------------------------------------------------------------
  app.get('/file', async (c) => {
    const key = c.req.query('key') ?? '';
    if (!isLibraryKey(layout, key)) return redirectWith(c, '/library', 'error', 'No such key.');
    const [head, asset, usage] = await Promise.all([
      deps.media ? deps.media.head(key) : Promise.resolve(null),
      getAsset(deps.db, key),
      usageOf(key),
    ]);
    const markup = head ? markupPanel(deps, key, asset) : null;
    return page(
      c,
      deps,
      key,
      <FilePage
        objectKey={key}
        head={head}
        asset={asset}
        preview={preview}
        publicUrl={publicUrl(deps, key)}
        hasStore={Boolean(deps.media)}
        today={today()}
        usage={usage}
        markup={markup}
        purge={deps.purge !== null}
      />,
      { modules: [...(markup ? ['/static/pr-markup.js'] : []), '/static/pr-upload.js'] },
    );
  });

  app.post('/file/save', async (c) => {
    const f = await c.req.parseBody();
    const key = str(f, 'key');
    if (!isLibraryKey(layout, key) || !IMAGE_KEY.test(key))
      return redirectWith(c, '/library', 'error', 'No such key.');
    const tags = parseTags(str(f, 'tags'));
    const rights = checkRights({
      licence: str(f, 'licence'),
      sourceUrl: str(f, 'source_url'),
      restrictions: str(f, 'restrictions'),
      expiresAt: str(f, 'expires_at'),
    });
    if (!rights.ok) return redirectWith(c, fileBack(key), 'error', `Not saved. ${rights.error}`);
    const current = await getAsset(deps.db, key);
    await fileAssets(
      deps.db,
      layout,
      [key],
      {
        subject: cleanSubject(str(f, 'subject')),
        addTags: tags,
        removeTags: (current?.tags ?? []).filter((t) => !tags.includes(t)),
        credit: str(f, 'credit').trim(),
        altDefault: str(f, 'alt_default').trim(),
        ...rights.rights,
      },
      actor(c),
      deps.now(),
    );
    await logAction(deps.db, {
      actor: actor(c),
      action: 'library.filed',
      detail: { keys: [key], changed: changedFields(current, await getAsset(deps.db, key)) },
    });
    return redirectWith(c, fileBack(key), 'success', 'Saved.');
  });

  app.post('/file/retire', async (c) => {
    const f = await c.req.parseBody();
    const key = str(f, 'key');
    if (!isLibraryKey(layout, key) || !IMAGE_KEY.test(key))
      return redirectWith(c, '/library', 'error', 'No such key.');
    const retired = str(f, 'retired') === '1';
    const note = str(f, 'note').trim() || null;
    await retireAsset(deps.db, key, note, retired, deps.now());
    await logAction(deps.db, {
      actor: actor(c),
      action: retired ? 'library.retired' : 'library.unretired',
      detail: { key, note },
    });
    // The Expiring view retires from its rows and wants to stay there.
    return redirectWith(
      c,
      backOf(str(f, 'back', fileBack(key))),
      'success',
      retired ? 'Retired. The object stays in the bucket.' : 'Back in use.',
    );
  });

  // Replace: new bytes under the same key, the one sanctioned overwrite. The
  // browser hashes the file and asks first; the PUT reads the whole body (the
  // cap keeps it small), checks the hash and the format before the write, so
  // the object is never left holding something the key does not describe.
  app.post('/file/replace/precheck', async (c) => {
    if (!deps.media) return c.json({ ok: false, error: NO_STORE }, 503);
    const body = (await c.req.json().catch(() => null)) as Partial<PrecheckEntry> | null;
    if (
      !body ||
      typeof body.key !== 'string' ||
      typeof body.sha256 !== 'string' ||
      typeof body.size !== 'number'
    )
      return c.json({ ok: false, error: 'Send key, sha256 and size.' }, 400);
    const answer = await replacePrecheck(deps.db, deps.media, layout, {
      key: body.key,
      sha256: body.sha256.toLowerCase(),
      size: body.size,
    });
    return c.json({ ok: true, answer });
  });

  app.put('/file/replace', async (c) => {
    if (!deps.media) return c.json({ ok: false, error: NO_STORE }, 503);
    const media = deps.media;
    const key = c.req.query('key') ?? '';
    if (!isLibraryKey(layout, key) || !WEB_IMAGE_KEY.test(key))
      return c.json({ ok: false, error: 'Not a key the library can replace.' }, 400);
    const length = Number(c.req.header('content-length') ?? 'NaN');
    if (!Number.isFinite(length) || length <= 0)
      return c.json({ ok: false, error: 'Content-Length is required.' }, 411);
    if (length > UPLOAD_MAX_BYTES) return c.json({ ok: false, error: TOO_BIG }, 413);
    const sha256 = (c.req.header('x-sha256') ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256))
      return c.json({ ok: false, error: 'X-SHA256 is required.' }, 400);
    const [head, asset] = await Promise.all([media.head(key), getAsset(deps.db, key)]);
    if (!head) return c.json({ ok: false, error: 'This key is not in the bucket.' }, 404);
    const from = knownSha256(head, asset);
    if (from === sha256)
      return c.json(
        { ok: false, error: 'The same bytes are already at this key; nothing to replace.' },
        409,
      );
    const bytes = await c.req.raw.arrayBuffer();
    if (bytes.byteLength !== length)
      return c.json({ ok: false, error: 'The body was not the declared length.' }, 400);
    if ((await sha256Hex(bytes)) !== sha256)
      return c.json({ ok: false, error: 'The bytes do not match X-SHA256; try again.' }, 400);
    const contentType = contentTypeFor(key);
    const sniffed = sniffImageType(bytes);
    if (sniffed !== contentType)
      return c.json(
        {
          ok: false,
          error: `This key is ${contentType}; the file is ${sniffed ?? 'not a web image'}. Keys keep their extension.`,
        },
        415,
      );
    const who = actor(c);
    const num = (h: string) => {
      const n = Number(c.req.header(h) ?? 'NaN');
      return Number.isInteger(n) && n > 0 ? n : null;
    };
    await media.put(key, bytes, contentType, {
      customMetadata: { sha256, uploadedBy: who, source: UPLOAD_SOURCE_TAG },
    });
    const after = await media.head(key);
    await recordReplace(
      deps.db,
      layout,
      {
        key,
        sha256,
        etag: after?.etag ?? null,
        bytes: after?.size ?? length,
        content_type: contentType,
        width: num('x-width'),
        height: num('x-height'),
        uploaded_by: who,
      },
      deps.now(),
    );
    await logAction(deps.db, {
      actor: who,
      action: 'library.replaced',
      detail: { key, from, to: sha256, bytes: after?.size ?? length },
    });
    const purge = await purgeKeys(who, [key]);
    // The page the browser goes to next shows this; the cookie rides on the JSON answer.
    setFlash(
      c,
      purge.configured && purge.error !== null ? 'warning' : 'success',
      `Replaced ${key}. ${purgeNote(purge)} Your own browser may keep its copy for up to an hour.`,
    );
    return c.json({ ok: true, key, bytes: after?.size ?? length, purge });
  });

  // Delete: anyone with access may remove a file for good, after the file page's
  // confirmation. The edge is purged when it can be; otherwise it may keep
  // resized copies for up to a day.
  app.post('/file/delete', async (c) => {
    const f = await c.req.parseBody();
    const key = str(f, 'key');
    if (!isLibraryKey(layout, key)) return redirectWith(c, '/library', 'error', 'No such key.');
    if (!deps.media) return redirectWith(c, fileBack(key), 'error', NO_STORE);
    if (str(f, 'confirm') !== 'delete')
      return redirectWith(
        c,
        fileBack(key),
        'error',
        'Not deleted: the confirmation was not ticked.',
      );
    const head = await deps.media.head(key);
    if (!head) {
      await forgetAsset(deps.db, key);
      return redirectWith(c, folderOf(key), 'success', `${key} was already gone; forgotten.`);
    }
    await deps.media.delete(key);
    await forgetAsset(deps.db, key);
    await logAction(deps.db, {
      actor: actor(c),
      action: 'library.deleted',
      detail: { key, size: head.size, etag: head.etag },
    });
    const purge = await purgeKeys(actor(c), [key]);
    return redirectWith(
      c,
      folderOf(key),
      purge.configured && purge.error !== null ? 'warning' : 'success',
      `Deleted ${key} from the bucket. ${purgeNote(purge)}`,
    );
  });

  // Bulk filing -------------------------------------------------------------
  function previewFrom(f: Record<string, unknown>): BulkPreview {
    const opt = (k: string) => {
      const v = str(f, k).trim();
      return v === '' ? undefined : v;
    };
    const subject = opt('subject');
    return {
      keys: [...new Set(many(f, 'keys'))].filter(
        (k) => isLibraryKey(layout, k) && IMAGE_KEY.test(k),
      ),
      subject: subject === undefined ? undefined : cleanSubject(subject),
      addTags: parseTags(str(f, 'add_tags')),
      removeTags: parseTags(str(f, 'remove_tags')),
      credit: opt('credit'),
      altPattern: opt('alt_pattern'),
      licence: opt('licence'),
      expiresAt: opt('expires_at'),
      back: backOf(str(f, 'back', '/library')),
    };
  }

  /** The bulk bar's rights fields, checked the same way as the file page's; a message when one is off. */
  const bulkRightsError = (p: BulkPreview): string | null => {
    const r = checkRights({ licence: p.licence ?? '', expiresAt: p.expiresAt ?? '' });
    return r.ok ? null : r.error;
  };

  app.post('/bulk', async (c) => {
    const preview = previewFrom(await c.req.parseBody({ all: true }));
    if (preview.keys.length === 0)
      return redirectWith(c, preview.back, 'warning', 'Nothing was selected.');
    if (
      preview.subject === undefined &&
      preview.addTags.length === 0 &&
      preview.removeTags.length === 0 &&
      preview.credit === undefined &&
      preview.altPattern === undefined &&
      preview.licence === undefined &&
      preview.expiresAt === undefined
    )
      return redirectWith(c, preview.back, 'warning', 'Nothing to change: fill in the bar first.');
    const problem = bulkRightsError(preview);
    if (problem) return redirectWith(c, preview.back, 'error', problem);
    return page(c, deps, 'File images', <BulkPreviewPage preview={preview} layout={layout} />);
  });

  app.post('/bulk/apply', async (c) => {
    const preview = previewFrom(await c.req.parseBody({ all: true }));
    // The preview checked these, but the apply is its own request.
    const problem = bulkRightsError(preview);
    if (problem) return redirectWith(c, preview.back, 'error', problem);
    const n = await fileAssets(
      deps.db,
      layout,
      preview.keys,
      {
        subject: preview.subject,
        addTags: preview.addTags,
        removeTags: preview.removeTags,
        credit: preview.credit,
        altPattern: preview.altPattern,
        licence: preview.licence,
        expiresAt: preview.expiresAt,
      },
      actor(c),
      deps.now(),
    );
    await logAction(deps.db, {
      actor: actor(c),
      action: 'library.filed',
      detail: {
        count: n,
        subject: preview.subject ?? null,
        addTags: preview.addTags,
        removeTags: preview.removeTags,
        ...(preview.credit !== undefined ? { credit: preview.credit } : {}),
        ...(preview.licence !== undefined ? { licence: preview.licence } : {}),
        ...(preview.expiresAt !== undefined ? { expires_at: preview.expiresAt } : {}),
      },
    });
    return redirectWith(c, preview.back, 'success', `Filed ${n} file${n === 1 ? '' : 's'}.`);
  });

  // Unfiled -----------------------------------------------------------------
  app.get('/unfiled', async (c) => {
    const [rows, total] = await Promise.all([listUnfiled(deps.db), countUnfiled(deps.db)]);
    const tiles = await tilesFor(
      rows.map((a) => ({ key: a.key, size: a.bytes ?? 0, uploaded: a.first_seen, etag: a.etag })),
    );
    return page(c, deps, 'Unfiled', <UnfiledPage tiles={tiles} preview={preview} total={total} />);
  });

  // Expiring ----------------------------------------------------------------
  app.get('/expiring', async (c) => {
    const day = today();
    return page(
      c,
      deps,
      'Expiring',
      <ExpiringPage assets={await listExpiring(deps.db, day)} today={day} preview={preview} />,
    );
  });

  /** The daily expiry run, now: what the cron would do at its next tick. */
  app.post('/expiring/run', async (c) => {
    const r = await retireExpired(deps.db, today(), actor(c));
    const n = r.retired.length;
    return redirectWith(
      c,
      '/library/expiring',
      'success',
      n === 0
        ? `Expiry run: nothing had expired before ${r.today}.`
        : `Expiry run: retired ${n} file${n === 1 ? '' : 's'} expired before ${r.today}.`,
    );
  });

  // Unused ------------------------------------------------------------------
  // The engine is asked for the keys WITH hits (one grouped list, paged) and
  // the library subtracts; asking per key would be thousands of statements.
  app.get('/unused', async (c) => {
    const requested = Number(c.req.query('page') ?? '1');
    const current = Number.isInteger(requested) && requested > 0 ? requested : 1;
    let tiles: Tile[] = [];
    let total = 0;
    let status: 'off' | 'ok' | 'error' = 'off';
    let message: string | null = null;
    if (deps.usage) {
      try {
        const active = await listActive(deps.db);
        const unused = new Set(
          await deps.usage.unusedKeys(
            active.map((a) => a.key),
            USAGE_RETENTION_DAYS,
          ),
        );
        const all = active.filter((a) => unused.has(a.key));
        total = all.length;
        tiles = all.slice((current - 1) * UNUSED_PAGE, current * UNUSED_PAGE).map((a) => ({
          object: { key: a.key, size: a.bytes ?? 0, uploaded: a.first_seen, etag: a.etag },
          asset: a,
        }));
        status = 'ok';
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
        console.error(JSON.stringify({ msg: 'unused lookup failed', error: message }));
        status = 'error';
      }
    }
    return page(
      c,
      deps,
      'Unused',
      <UnusedPage
        tiles={tiles}
        preview={preview}
        total={total}
        page={current}
        pages={Math.max(1, Math.ceil(total / UNUSED_PAGE))}
        status={status}
        message={message}
      />,
    );
  });

  // Rescan ------------------------------------------------------------------
  app.post('/rescan', async (c) => {
    if (!deps.media) return redirectWith(c, '/library', 'error', NO_STORE);
    const r = await rescan(deps.db, deps.media, layout, deps.now());
    await logAction(deps.db, {
      actor: actor(c),
      action: 'library.rescan',
      detail: { ...r, changed: r.changed.length },
    });
    // Bytes replaced outside the library (rclone, the dashboard) are still the
    // old bytes at the edge until purged, exactly as after a Replace here. A
    // whole-bucket resync could change hundreds of keys, and each one is five
    // purge calls, so only the first few are purged within this request: a
    // Worker has a subrequest budget, and running out of it would fail the
    // rescan itself. The rest refresh within a day, and the flash says so.
    let note = '';
    if (r.changed.length) {
      await logAction(deps.db, {
        actor: actor(c),
        action: 'library.changed',
        detail: { keys: r.changed },
      });
      const purged = r.changed.slice(0, RESCAN_PURGE_KEYS);
      const purge = await purgeKeys(actor(c), purged);
      note = ` ${purgeNote(purge)}`;
      if (purge.configured && purge.error === null && purged.length < r.changed.length)
        note = ` Cached copies purged for the first ${purged.length} changed keys; the rest refresh within a day.`;
    }
    return redirectWith(
      c,
      '/library',
      'success',
      `Rescan: ${r.listed} objects listed, ${r.added} new to the library${
        r.completed ? `, ${r.completed} upload record${r.completed === 1 ? '' : 's'} completed` : ''
      }${r.changed.length ? `, ${r.changed.length} changed (bytes replaced outside)` : ''}${
        r.forgotten ? `, ${r.forgotten} forgotten (object gone)` : ''
      }.${note}`,
    );
  });

  // Upload ------------------------------------------------------------------
  /** Two levels of subject folders under the upload prefix, for the datalist. */
  async function subjectFolders(media: MediaBucket): Promise<string[]> {
    const out: string[] = [];
    const root = layout.uploadPrefix;
    const top = await media.list(root, { delimiter: '/' });
    for (const p of top.prefixes) {
      out.push(p.slice(root.length, -1));
      const sub = await media.list(p, { delimiter: '/' });
      for (const q of sub.prefixes) out.push(q.slice(root.length, -1));
    }
    return out;
  }

  app.get('/upload', async (c) =>
    page(
      c,
      deps,
      'Upload',
      <UploadPage
        subjects={deps.media ? await subjectFolders(deps.media) : []}
        subject={cleanSubject(c.req.query('subject') ?? '')}
        layout={layout}
        hasStore={Boolean(deps.media)}
      />,
      { modules: ['/static/pr-upload.js'] },
    ),
  );

  app.post('/precheck', async (c) => {
    if (!deps.media) return c.json({ ok: false, error: NO_STORE }, 503);
    const body = (await c.req.json().catch(() => null)) as { entries?: unknown } | null;
    const raw = Array.isArray(body?.entries) ? (body?.entries as unknown[]) : null;
    if (!raw || raw.length > 200)
      return c.json({ ok: false, error: 'Send up to 200 entries.' }, 400);
    const entries: PrecheckEntry[] = raw
      .map((e) => e as Partial<PrecheckEntry>)
      .filter(
        (e): e is PrecheckEntry =>
          typeof e.key === 'string' && typeof e.sha256 === 'string' && typeof e.size === 'number',
      );
    const answers = await precheck(deps.db, deps.media, layout, entries);
    return c.json({ ok: true, answers });
  });

  app.put('/upload/*', async (c) => {
    if (!deps.media) return c.json({ ok: false, error: NO_STORE }, 503);
    const media = deps.media;
    let key: string;
    try {
      key = decodeURIComponent(c.req.path.replace(/^\/library\/upload\//, ''));
    } catch {
      return c.json({ ok: false, error: 'Bad key.' }, 400);
    }
    if (!uploadPattern.test(key)) return c.json({ ok: false, error: 'Bad key.' }, 400);
    const length = Number(c.req.header('content-length') ?? 'NaN');
    if (!Number.isFinite(length) || length <= 0)
      return c.json({ ok: false, error: 'Content-Length is required.' }, 411);
    if (length > UPLOAD_MAX_BYTES) return c.json({ ok: false, error: TOO_BIG }, 413);
    const sha256 = (c.req.header('x-sha256') ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256))
      return c.json({ ok: false, error: 'X-SHA256 is required.' }, 400);
    const contentType = contentTypeFor(key);
    const who = actor(c);
    const num = (h: string) => {
      const n = Number(c.req.header(h) ?? 'NaN');
      return Number.isInteger(n) && n > 0 ? n : null;
    };
    // The capture entry is a courtesy from the browser, not a condition of the
    // upload: a bad one is logged and dropped, and the response says what was dropped.
    const { capture, problems } = parseCaptureHeader(c.req.header('x-capture'));
    if (problems.length) console.warn(`X-Capture for ${key} partly ignored: ${problems.join(' ')}`);
    const warnings = problems.length ? { warnings: problems } : {};
    const record = async (head: { size: number; etag: string | null } | null, action: string) => {
      await recordUpload(
        deps.db,
        layout,
        {
          key,
          sha256,
          etag: head?.etag ?? null,
          bytes: head?.size ?? length,
          content_type: contentType,
          width: num('x-width'),
          height: num('x-height'),
          uploaded_by: who,
          capture,
        },
        deps.now(),
      );
      await logAction(deps.db, {
        actor: who,
        action,
        detail: { key, bytes: head?.size ?? length },
      });
    };
    const existing = await media.head(key);
    if (existing) {
      // The same bytes again is a retry whose first attempt stored the object but lost
      // its record: complete the record instead of refusing. A different file at the key
      // is never overwritten.
      if (existing.customMetadata?.sha256 === sha256) {
        await record(existing, 'library.upload_completed');
        return c.json({ ok: true, key, bytes: existing.size, completed: true, ...warnings });
      }
      return c.json(
        {
          ok: false,
          error: 'A different file is already at this key. Keys are never overwritten.',
        },
        409,
      );
    }
    const body = c.req.raw.body;
    if (!body) return c.json({ ok: false, error: 'No body.' }, 400);
    await media.put(key, body, contentType, {
      customMetadata: { sha256, uploadedBy: who, source: UPLOAD_SOURCE_TAG },
    });
    const head = await media.head(key);
    await record(head, 'library.uploaded');
    return c.json({ ok: true, key, bytes: head?.size ?? length, ...warnings });
  });

  // Duplicates --------------------------------------------------------------
  app.get('/duplicates', async (c) =>
    page(
      c,
      deps,
      'Duplicates',
      <DuplicatesPage groups={await listDuplicates(deps.db)} preview={preview} />,
    ),
  );

  app.post('/duplicates/resolve', async (c) => {
    const f = await c.req.parseBody();
    const keep = str(f, 'keep');
    const hash = str(f, 'hash');
    const group = (await listDuplicates(deps.db)).find((g) => g.hash === hash);
    if (!group?.assets.some((a) => a.key === keep))
      return redirectWith(c, '/library/duplicates', 'error', 'That group has changed; look again.');
    const others = group.assets.filter((a) => a.key !== keep);
    for (const a of others)
      await retireAsset(deps.db, a.key, `duplicate of ${keep}`, true, deps.now());
    await logAction(deps.db, {
      actor: actor(c),
      action: 'library.duplicates_resolved',
      detail: { keep, retired: others.map((a) => a.key) },
    });
    return redirectWith(
      c,
      '/library/duplicates',
      'success',
      `Kept ${keep}; retired ${others.length}.`,
    );
  });

  return app;
}
