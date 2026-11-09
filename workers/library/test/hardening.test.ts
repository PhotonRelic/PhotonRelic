/**
 * The findings of the 2026-11 security audit, each pinned by a test: the
 * local identity answers on localhost only, uploads are checked before they
 * are stored, every response carries the security headers, master links keep
 * to an allowlist of schemes, a Rescan runs one at a time, and a search page
 * is bounded.
 */
import { describe, expect, it } from 'vitest';
import { LocalhostVerifier } from '../src/access.js';
import { createApp } from '../src/app.jsx';
import { recentActions } from '../src/audit.js';
import { depsFromEnv } from '../src/index.jsx';
import { acquireLock, getAsset, isMasterUrl, releaseLock } from '../src/library.js';
import { MemoryMediaBucket } from '../src/media.js';
import { bytes, harness, jpeg, ORIGIN, png, sha256, text } from './helpers.js';

const KEY = 'media/products/chair.jpg';

describe('local development identity', () => {
  it('needs DEV_IDENTITY to exist at all, whatever ENVIRONMENT says', () => {
    const env = { DB: {} as D1Database, ENVIRONMENT: 'local', ACCESS_TEAM_DOMAIN: '' };
    expect(() => depsFromEnv(env)).toThrow(/ACCESS_AUD must be set/);
    expect(() => depsFromEnv({ ...env, ENVIRONMENT: 'production' })).toThrow(/ACCESS_AUD/);
    expect(depsFromEnv({ ...env, DEV_IDENTITY: 'dev@localhost' }).access).toBeInstanceOf(
      LocalhostVerifier,
    );
  });

  it('answers on localhost only, so a deployed configuration without Access has no door', async () => {
    const deps = depsFromEnv({
      DB: {} as D1Database,
      ENVIRONMENT: 'local',
      ACCESS_TEAM_DOMAIN: '',
      DEV_IDENTITY: 'dev@localhost',
    });
    const app = createApp({ ...deps, db: harness().db, media: new MemoryMediaBucket() });
    expect((await app.request('http://localhost:8787/library')).status).toBe(200);
    expect((await app.request('http://127.0.0.1:8787/library')).status).toBe(200);
    expect((await app.request('https://media-admin.example.com/library')).status).toBe(401);
    expect((await app.request('https://localhost.example.com/library')).status).toBe(401);
  });
});

describe('uploads are checked before they are stored', () => {
  it('refuses bytes that do not match the declared hash, and a file that is not what the key says', async () => {
    const h = harness();
    const lied = await h.put(KEY, jpeg('real'), { 'x-sha256': await sha256(jpeg('other')) });
    expect(lied.status).toBe(400);
    expect(((await lied.json()) as { error: string }).error).toMatch(/do not match/);
    const notImage = await h.put(KEY, text('<html>not a photo</html>'));
    expect(notImage.status).toBe(415);
    const wrongFormat = await h.put(KEY, png('a png under a jpg key'));
    expect(wrongFormat.status).toBe(415);
    expect(h.media.objects.has(KEY)).toBe(false);
    expect(await getAsset(h.db, KEY)).toBeNull();
    expect((await h.put(KEY, jpeg('real'))).status).toBe(200);
    expect((await h.put('media/products/scan.png', png('scan'))).status).toBe(200);
  });

  it('completes a lost record without rewriting what the object already said', async () => {
    const h = harness();
    await h.put(KEY, bytes('v1'), { 'x-width': '2000', 'x-height': '1500' });
    const before = await getAsset(h.db, KEY);
    expect(before).toMatchObject({ width: 2000, height: 1500, uploaded_by: 'staff@example.com' });
    // The same bytes again, this time claiming other dimensions and capture data.
    const retry = await h.put(KEY, bytes('v1'), {
      'x-width': '1',
      'x-height': '1',
      'x-capture': JSON.stringify({ camera: 'Fake Camera' }),
    });
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { completed?: boolean }).completed).toBe(true);
    const after = await getAsset(h.db, KEY);
    expect(after).toMatchObject({ width: 2000, height: 1500 });
    // A field the record lacked is filled; one it had is kept.
    expect(after?.camera).toBe('Fake Camera');
  });

  it('lets one of two racing uploads win the key', async () => {
    const h = harness();
    const first = await h.media.put(KEY, bytes('first'), 'image/jpeg', { ifAbsent: true });
    const second = await h.media.put(KEY, bytes('second'), 'image/jpeg', { ifAbsent: true });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(new Uint8Array(h.media.objects.get(KEY)?.bytes ?? new ArrayBuffer(0))).toEqual(
      new Uint8Array(bytes('first')),
    );
  });
});

describe('response headers', () => {
  it('are on the 401, the 404 page and the error page too', async () => {
    const h = harness({ access: { verify: async () => null } });
    const denied = await h.app.request(`${ORIGIN}/library`);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('x-frame-options')).toBe('DENY');
    expect(denied.headers.get('x-content-type-options')).toBe('nosniff');
    expect(denied.headers.get('cache-control')).toBe('no-store');
    const ok = harness();
    const missing = await ok.req('/library/no-such-page');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(missing.headers.get('permissions-policy')).toContain('camera=()');
    // A handler that throws still answers with the headers, and says nothing to a stranger.
    const broken = harness();
    broken.db.prepare = () => {
      throw new Error('database exploded');
    };
    const err = await broken.req('/library/search?q=chair');
    expect(err.status).toBe(500);
    expect(err.headers.get('x-frame-options')).toBe('DENY');
    expect(err.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const strangerDeps = harness({
      access: {
        verify: async () => {
          throw new Error('certs down');
        },
      },
    });
    const stranger = await strangerDeps.app.request(`${ORIGIN}/library`);
    expect(stranger.status).toBe(500);
    expect(await stranger.text()).not.toContain('certs down');
    expect(stranger.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('master links', () => {
  it('keep to the allowed schemes', () => {
    for (const ok of [
      'https://drive.example.com/file/d/abc',
      'http://nas.local/share/x.psd',
      's3://bucket/masters/x.psd',
      'gs://bucket/x.psd',
      'azure://container/x.psd',
      'smb://nas/share/Shared Documents/x.psd',
      'file:///Volumes/Masters/x.psd',
    ])
      expect(isMasterUrl(ok), ok).toBe(true);
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox',
      'blob:https://example.com/abc',
      'mailto:someone@example.com',
      'https:',
      'not a url',
      'https://example.com/\u0007bell',
    ])
      expect(isMasterUrl(bad), bad).toBe(false);
  });

  it('are refused on the file page when the scheme is not allowed', async () => {
    const h = harness();
    await h.put(KEY, bytes('web'));
    const saved = await h.form('/library/file/save', [
      ['key', KEY],
      ['master_url', 'javascript:alert(1)'],
    ]);
    expect(saved.status).toBe(303);
    expect((await getAsset(h.db, KEY))?.master_url ?? null).toBeNull();
    const page = await (await h.req(`/library/file?key=${encodeURIComponent(KEY)}`)).text();
    expect(page).not.toContain('javascript:alert');
  });
});

describe('one rescan at a time', () => {
  it('takes the lock, refuses a second run, and takes over a stale one', async () => {
    const h = harness();
    const now = new Date('2026-11-09T12:00:00.000Z');
    expect(await acquireLock(h.db, 'rescan', 'a@example.com', now)).toEqual({ ok: true });
    const held = await acquireLock(h.db, 'rescan', 'b@example.com', new Date(now.getTime() + 1000));
    expect(held).toMatchObject({ ok: false, actor: 'a@example.com' });
    const later = new Date(now.getTime() + 16 * 60 * 1000);
    expect(await acquireLock(h.db, 'rescan', 'b@example.com', later)).toEqual({ ok: true });
    await releaseLock(h.db, 'rescan');
    expect(await acquireLock(h.db, 'rescan', 'c@example.com', later)).toEqual({ ok: true });
  });

  it('the page says who is running it, and releases the lock when the run ends', async () => {
    const h = harness();
    await acquireLock(h.db, 'rescan', 'someone@example.com', h.deps.now());
    const busy = await h.form('/library/rescan', []);
    expect(busy.status).toBe(303);
    const flashed = await h.req('/library', {
      headers: { cookie: busy.headers.get('set-cookie') ?? '' },
    });
    expect(await flashed.text()).toContain('still running');
    await releaseLock(h.db, 'rescan');
    expect((await h.form('/library/rescan', [])).status).toBe(303);
    expect((await recentActions(h.db, 1))[0]?.action).toBe('library.rescan');
    // The lock is gone after the run.
    expect(await acquireLock(h.db, 'rescan', 'x@example.com', h.deps.now())).toEqual({ ok: true });
  });
});

describe('search paging', () => {
  it('does not ask the database for a page nobody has', async () => {
    const h = harness();
    for (const q of ['1e15', 'Infinity', '-5', 'abc', '2.7']) {
      const res = await h.req(`/library/search?q=chair&page=${q}`);
      expect(res.status, q).toBe(200);
    }
  });
});
