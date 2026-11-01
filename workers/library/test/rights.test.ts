import { describe, expect, it } from 'vitest';
import { recentActions } from '../src/audit.js';
import {
  checkRights,
  countExpiring,
  EXPIRY_ACTOR,
  fileAssets,
  getAsset,
  isIsoDate,
  listExpiring,
  plusDays,
  retireAsset,
  retireExpired,
} from '../src/library.js';
import { bytes, harness, ORIGIN, STAFF } from './helpers.js';

/** The harness clock is 2026-10-30T12:00Z. */
const TODAY = '2026-10-30';
const YESTERDAY = '2026-10-29';
const NOW = new Date(`${TODAY}T12:00:00.000Z`);

/** The flash a redirect carries, decoded from its cookie (URL-encoded base64 of the JSON). */
function flashOf(res: Response): { level: string; message: string } | null {
  const raw = res.headers
    .get('set-cookie')
    ?.split(';')[0]
    ?.replace(/^pr_flash=/, '');
  if (!raw) return null;
  const json = decodeURIComponent(escape(atob(decodeURIComponent(raw))));
  return JSON.parse(json) as { level: string; message: string };
}

/** A row with an expiry and nothing else, the way the bulk bar would make one. */
async function expiring(h: ReturnType<typeof harness>, key: string, expiresAt: string) {
  await fileAssets(h.db, h.deps.layout, [key], { expiresAt }, 'seed@example.com', NOW);
}

describe('rights migration', () => {
  it('adds the four nullable columns and the expiry index', () => {
    const h = harness();
    const columns = h.db.raw
      .prepare('PRAGMA table_info(assets)')
      .all()
      .map((c) => c as { name: string; notnull: number });
    const names = columns.map((c) => c.name);
    for (const col of ['licence', 'source_url', 'restrictions', 'expires_at']) {
      expect(names).toContain(col);
      expect(columns.find((c) => c.name === col)?.notnull).toBe(0);
    }
    const indexes = h.db.raw
      .prepare('PRAGMA index_list(assets)')
      .all()
      .map((i) => (i as { name: string }).name);
    expect(indexes).toContain('assets_expires_at');
  });
});

describe('rights validation', () => {
  it('accepts blanks and well-formed values, trimmed', () => {
    const r = checkRights({
      licence: ' CC BY 4.0 ',
      sourceUrl: 'https://example.com/photo ',
      restrictions: 'editorial only',
      expiresAt: '2026-12-31',
    });
    expect(r).toEqual({
      ok: true,
      rights: {
        licence: 'CC BY 4.0',
        sourceUrl: 'https://example.com/photo',
        restrictions: 'editorial only',
        expiresAt: '2026-12-31',
      },
    });
    expect(checkRights({})).toMatchObject({ ok: true });
    expect(checkRights({ sourceUrl: 'http://example.com' })).toMatchObject({ ok: true });
  });

  it('refuses a source URL that is not http(s)', () => {
    expect(checkRights({ sourceUrl: 'ftp://example.com/a' })).toMatchObject({ ok: false });
    expect(checkRights({ sourceUrl: 'javascript:alert(1)' })).toMatchObject({ ok: false });
    expect(checkRights({ sourceUrl: 'example.com/photo' })).toMatchObject({ ok: false });
  });

  it('refuses a date that is malformed or does not exist', () => {
    expect(checkRights({ expiresAt: '2026-02-30' })).toMatchObject({ ok: false });
    expect(checkRights({ expiresAt: '30/10/2026' })).toMatchObject({ ok: false });
    expect(checkRights({ expiresAt: '2026-10-30T00:00:00Z' })).toMatchObject({ ok: false });
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2023-02-29')).toBe(false);
    expect(plusDays('2026-12-31', 30)).toBe('2027-01-30');
    expect(plusDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('bounds the text fields', () => {
    expect(checkRights({ licence: 'x'.repeat(201) })).toMatchObject({ ok: false });
    expect(checkRights({ licence: 'x'.repeat(200) })).toMatchObject({ ok: true });
    expect(checkRights({ restrictions: 'x'.repeat(2001) })).toMatchObject({ ok: false });
    expect(checkRights({ sourceUrl: `https://example.com/${'x'.repeat(2048)}` })).toMatchObject({
      ok: false,
    });
  });
});

describe('file page', () => {
  it('saves the rights fields, clears them with blanks, and audits what changed', async () => {
    const h = harness();
    await h.put('media/x/a.jpg', bytes('a'));
    const save = await h.form('/library/file/save', [
      ['key', 'media/x/a.jpg'],
      ['subject', 'x'],
      ['licence', 'CC BY 4.0'],
      ['source_url', 'https://example.com/a'],
      ['restrictions', 'Editorial only'],
      ['expires_at', '2026-12-31'],
    ]);
    expect(save.status).toBe(303);
    expect(await getAsset(h.db, 'media/x/a.jpg')).toMatchObject({
      licence: 'CC BY 4.0',
      source_url: 'https://example.com/a',
      restrictions: 'Editorial only',
      expires_at: '2026-12-31',
    });
    const audit = (await recentActions(h.db))[0];
    expect(audit?.action).toBe('library.filed');
    expect(audit?.detail?.changed).toEqual({
      licence: 'CC BY 4.0',
      source_url: 'https://example.com/a',
      restrictions: 'Editorial only',
      expires_at: '2026-12-31',
    });

    const page = await (await h.req('/library/file?key=media/x/a.jpg')).text();
    expect(page).toContain('value="2026-12-31"');
    expect(page).toContain('Editorial only');

    await h.form('/library/file/save', [
      ['key', 'media/x/a.jpg'],
      ['subject', 'x'],
      ['licence', 'CC BY 4.0'],
    ]);
    expect(await getAsset(h.db, 'media/x/a.jpg')).toMatchObject({
      licence: 'CC BY 4.0',
      source_url: null,
      restrictions: null,
      expires_at: null,
    });
    expect((await recentActions(h.db))[0]?.detail?.changed).toEqual({
      source_url: null,
      restrictions: null,
      expires_at: null,
    });
  });

  it('refuses a bad source URL or date and saves nothing', async () => {
    const h = harness();
    await h.put('media/x/a.jpg', bytes('a'));
    const before = await getAsset(h.db, 'media/x/a.jpg');
    const badUrl = await h.form('/library/file/save', [
      ['key', 'media/x/a.jpg'],
      ['subject', 'changed'],
      ['source_url', 'ftp://example.com/a'],
    ]);
    expect(badUrl.status).toBe(303);
    expect(badUrl.headers.get('location')).toBe('/library/file?key=media%2Fx%2Fa.jpg');
    expect(flashOf(badUrl)).toMatchObject({ level: 'error' });
    expect(flashOf(badUrl)?.message).toContain('http');
    const badDate = await h.form('/library/file/save', [
      ['key', 'media/x/a.jpg'],
      ['subject', 'changed'],
      ['expires_at', '2026-13-01'],
    ]);
    expect(flashOf(badDate)?.message).toContain('YYYY-MM-DD');
    expect(await getAsset(h.db, 'media/x/a.jpg')).toEqual(before);
  });
});

describe('bulk filing', () => {
  it('previews and applies a licence and an expiry, and leaves them when blank', async () => {
    const h = harness();
    await h.media.put('media/x/one.jpg', bytes('1'), 'image/jpeg');
    await h.media.put('media/x/two.jpg', bytes('2'), 'image/jpeg');
    const fields: [string, string][] = [
      ['keys', 'media/x/one.jpg'],
      ['keys', 'media/x/two.jpg'],
      ['licence', 'Licensed from Studio'],
      ['expires_at', '2027-01-15'],
      ['back', '/library?prefix=media/x/'],
    ];
    const previewHtml = await (await h.form('/library/bulk', fields)).text();
    expect(previewHtml).toContain('Licensed from Studio');
    expect(previewHtml).toContain('2027-01-15');
    expect(previewHtml).toContain('name="expires_at" value="2027-01-15"');

    const apply = await h.form('/library/bulk/apply', fields);
    expect(apply.status).toBe(303);
    for (const key of ['media/x/one.jpg', 'media/x/two.jpg'])
      expect(await getAsset(h.db, key)).toMatchObject({
        licence: 'Licensed from Studio',
        expires_at: '2027-01-15',
      });
    expect((await recentActions(h.db))[0]?.detail).toMatchObject({
      count: 2,
      licence: 'Licensed from Studio',
      expires_at: '2027-01-15',
    });

    // A second filing with the rights fields blank changes neither.
    await h.form('/library/bulk/apply', [
      ['keys', 'media/x/one.jpg'],
      ['add_tags', 'hero'],
    ]);
    expect(await getAsset(h.db, 'media/x/one.jpg')).toMatchObject({
      tags: ['hero'],
      licence: 'Licensed from Studio',
      expires_at: '2027-01-15',
    });
  });

  it('counts the rights fields as a change, and refuses a bad date before and at apply', async () => {
    const h = harness();
    await h.media.put('media/x/one.jpg', bytes('1'), 'image/jpeg');
    const onlyExpiry = await h.form('/library/bulk', [
      ['keys', 'media/x/one.jpg'],
      ['expires_at', '2027-01-15'],
    ]);
    expect(onlyExpiry.status).toBe(200);

    const bad: [string, string][] = [
      ['keys', 'media/x/one.jpg'],
      ['expires_at', 'next year'],
      ['back', '/library?prefix=media/x/'],
    ];
    const preview = await h.form('/library/bulk', bad);
    expect(preview.status).toBe(303);
    expect(preview.headers.get('location')).toBe('/library?prefix=media/x/');
    expect(flashOf(preview)).toMatchObject({ level: 'error' });
    const apply = await h.form('/library/bulk/apply', bad);
    expect(apply.status).toBe(303);
    expect(await getAsset(h.db, 'media/x/one.jpg')).toBeNull();
  });
});

describe('expiring', () => {
  async function seed(h: ReturnType<typeof harness>) {
    await expiring(h, 'media/x/yesterday.jpg', YESTERDAY);
    await expiring(h, 'media/x/today.jpg', TODAY);
    await expiring(h, 'media/x/edge.jpg', plusDays(TODAY, 30));
    await expiring(h, 'media/x/later.jpg', plusDays(TODAY, 31));
    await expiring(h, 'media/x/gone.jpg', YESTERDAY);
    await retireAsset(h.db, 'media/x/gone.jpg', 'reshot', true, NOW);
    await expiring(h, 'media/x/open.jpg', '');
  }

  it('lists what has expired or expires within 30 days, soonest first, retired excluded', async () => {
    const h = harness();
    await seed(h);
    expect((await listExpiring(h.db, TODAY)).map((a) => a.key)).toEqual([
      'media/x/yesterday.jpg',
      'media/x/today.jpg',
      'media/x/edge.jpg',
    ]);
    expect(await countExpiring(h.db, TODAY)).toBe(3);

    const html = await (await h.req('/library/expiring')).text();
    expect(html).toContain('yesterday.jpg');
    expect(html).toContain('>expired<');
    expect(html).toContain('expires today');
    expect(html).toContain('expires in 30 days');
    expect(html).not.toContain('later.jpg');
    expect(html).not.toContain('gone.jpg');
    expect(html).toContain('action="/library/file/retire"');
    expect(html).toContain('action="/library/expiring/run"');

    const library = await (await h.req('/library')).text();
    expect(library).toContain('Expiring or expired');
    expect(library).toContain('href="/library/expiring"');
  });

  it('shows no badge when nothing is expiring', async () => {
    const h = harness();
    await expiring(h, 'media/x/later.jpg', plusDays(TODAY, 31));
    const html = await (await h.req('/library')).text();
    expect(html).not.toContain('Expiring or expired');
    expect(await (await h.req('/library/expiring')).text()).toContain('Nothing expires');
  });

  it('retires from a row and comes back to the view', async () => {
    const h = harness();
    await seed(h);
    const res = await h.form('/library/file/retire', [
      ['key', 'media/x/today.jpg'],
      ['retired', '1'],
      ['note', `Expires ${TODAY}`],
      ['back', '/library/expiring'],
    ]);
    expect(res.headers.get('location')).toBe('/library/expiring');
    expect(await getAsset(h.db, 'media/x/today.jpg')).toMatchObject({
      retired: true,
      retired_note: `Expires ${TODAY}`,
    });
    expect(await countExpiring(h.db, TODAY)).toBe(2);
  });
});

describe('expiry run', () => {
  it('retires what expired before today, once, with an audit row per file and one for the run', async () => {
    const h = harness();
    await expiring(h, 'media/x/yesterday.jpg', YESTERDAY);
    await expiring(h, 'media/x/older.jpg', '2026-01-01');
    await expiring(h, 'media/x/today.jpg', TODAY);
    await expiring(h, 'media/x/gone.jpg', YESTERDAY);
    await retireAsset(h.db, 'media/x/gone.jpg', 'reshot', true, NOW);

    const first = await retireExpired(h.db, TODAY);
    expect(first).toEqual({
      today: TODAY,
      retired: ['media/x/older.jpg', 'media/x/yesterday.jpg'],
    });
    expect(await getAsset(h.db, 'media/x/yesterday.jpg')).toMatchObject({
      retired: true,
      retired_note: `Expired ${YESTERDAY}`,
    });
    expect(await getAsset(h.db, 'media/x/older.jpg')).toMatchObject({
      retired: true,
      retired_note: 'Expired 2026-01-01',
    });
    expect((await getAsset(h.db, 'media/x/today.jpg'))?.retired).toBe(false);
    expect((await getAsset(h.db, 'media/x/gone.jpg'))?.retired_note).toBe('reshot');

    const audit = await recentActions(h.db);
    expect(audit[0]).toMatchObject({
      actor: EXPIRY_ACTOR,
      action: 'library.expiry_run',
      detail: { today: TODAY, count: 2, keys: ['media/x/older.jpg', 'media/x/yesterday.jpg'] },
    });
    expect(audit.slice(1, 3).map((e) => [e.actor, e.action, e.detail?.key])).toEqual([
      [EXPIRY_ACTOR, 'library.retired', 'media/x/yesterday.jpg'],
      [EXPIRY_ACTOR, 'library.retired', 'media/x/older.jpg'],
    ]);
    expect(audit[1]?.detail).toMatchObject({ note: `Expired ${YESTERDAY}`, expires_at: YESTERDAY });

    const again = await retireExpired(h.db, TODAY);
    expect(again.retired).toEqual([]);
    const after = await recentActions(h.db);
    expect(after).toHaveLength(audit.length + 1);
    expect(after[0]).toMatchObject({ action: 'library.expiry_run', detail: { count: 0 } });
    expect(after.filter((e) => e.action === 'library.retired')).toHaveLength(2);

    await expect(retireExpired(h.db, 'tomorrow')).rejects.toThrow();
  });

  it('runs from the Expiring page, same-origin only, naming who asked', async () => {
    const h = harness();
    await expiring(h, 'media/x/yesterday.jpg', YESTERDAY);
    const evil = await h.app.request(`${ORIGIN}/library/expiring/run`, {
      method: 'POST',
      headers: { origin: 'https://evil.example.net' },
    });
    expect(evil.status).toBe(403);
    expect((await getAsset(h.db, 'media/x/yesterday.jpg'))?.retired).toBe(false);

    const res = await h.form('/library/expiring/run', []);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/library/expiring');
    expect(flashOf(res)?.message).toContain('retired 1 file');
    expect((await getAsset(h.db, 'media/x/yesterday.jpg'))?.retired).toBe(true);
    expect((await recentActions(h.db))[0]).toMatchObject({
      actor: EXPIRY_ACTOR,
      action: 'library.expiry_run',
      detail: { count: 1, requested_by: STAFF.email },
    });
    expect(flashOf(await h.form('/library/expiring/run', []))?.message).toContain('nothing');
  });
});
