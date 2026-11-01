import { menuFromLists, variantUrls } from '@photonrelic/media-params';
import { describe, expect, it, vi } from 'vitest';
import { recentActions } from '../src/audit.js';
import {
  focalOf,
  getAsset,
  listDuplicates,
  noteSeen,
  parseCaptureHeader,
  parseFocal,
} from '../src/library.js';
import { layoutFromVars, sniffImageType, subjectOf, uploadKeyPattern } from '../src/media.js';
import type { UsageCounts, UsageReader } from '../src/usage.js';
import { bytes, fakePurge, harness, jpeg, ORIGIN, png, STAFF, sha256 } from './helpers.js';

/** The flash the next page would show, from the cookie a write set. */
const flashOf = (res: Response): string => {
  const raw = /pr_flash=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  const json = decodeURIComponent(escape(atob(decodeURIComponent(raw))));
  return (JSON.parse(json) as { message: string }).message;
};

/** A usage reader over a fixed table of counts; keys off the table have no hits. */
class FakeUsage implements UsageReader {
  constructor(readonly table: Record<string, UsageCounts> = {}) {}
  async usageFor(keys: string[]) {
    const out = new Map<string, UsageCounts>();
    for (const k of keys) if (this.table[k]) out.set(k, this.table[k]);
    return out;
  }
  async unusedKeys(known: string[]) {
    return known.filter((k) => !this.table[k]);
  }
}

class BrokenUsage implements UsageReader {
  async usageFor(): Promise<Map<string, UsageCounts>> {
    throw new Error('SQL API answered 500');
  }
  async unusedKeys(): Promise<string[]> {
    throw new Error('SQL API answered 500');
  }
}

describe('access and request hygiene', () => {
  it('refuses a request without an Access identity', async () => {
    const h = harness({ access: { verify: async () => null } });
    const res = await h.req('/library');
    expect(res.status).toBe(401);
  });

  it('refuses a cross-site write and allows a same-origin one', async () => {
    const h = harness();
    const evil = await h.app.request(`${ORIGIN}/library/rescan`, {
      method: 'POST',
      headers: { origin: 'https://evil.example.net' },
    });
    expect(evil.status).toBe(403);
    const fetchSite = await h.app.request(`${ORIGIN}/library/rescan`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(fetchSite.status).toBe(403);
    expect((await h.form('/library/rescan', [])).status).toBe(303);
  });

  it('sets the security headers and a CSP on pages', async () => {
    const h = harness();
    const res = await h.req('/library');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain('img-src');
    expect(res.headers.get('content-security-policy')).toContain('https://img.example.com');
    const html = await res.text();
    expect(html).toContain('PhotonRelic');
    expect(html).toContain(STAFF.email);
  });
});

describe('layout', () => {
  it('always lists the upload prefix and refuses malformed or overlapping prefixes', () => {
    expect(layoutFromVars(undefined, undefined)).toEqual({
      uploadPrefix: 'media/',
      libraryPrefixes: ['media/'],
    });
    expect(layoutFromVars('assets/', 'old/').libraryPrefixes).toEqual(['assets/', 'old/']);
    expect(() => layoutFromVars('Media/')).toThrow();
    expect(() => layoutFromVars('media')).toThrow();
    expect(() => layoutFromVars('media/', 'media/old/')).toThrow(/overlap/);
  });

  it('builds the upload key rule and subjects from the prefix', () => {
    const layout = layoutFromVars('assets/web/');
    const p = uploadKeyPattern(layout);
    expect(p.test('assets/web/products/chair.jpg')).toBe(true);
    expect(p.test('assets/web/chair.jpg')).toBe(false);
    expect(p.test('assets/web/Products/chair.jpg')).toBe(false);
    expect(p.test('media/products/chair.jpg')).toBe(false);
    expect(subjectOf(layout, 'assets/web/products/chairs/a.jpg')).toBe('products/chairs');
    expect(subjectOf(layout, 'other/a.jpg')).toBeNull();
  });
});

describe('upload', () => {
  it('prechecks, stores, records and files an upload under its subject', async () => {
    const h = harness();
    const a = bytes('image-a');
    const pre = await h.precheck([{ key: 'media/products/chairs/a.jpg', body: a }]);
    expect(pre.answers[0]?.status).toBe('ok');

    const res = await h.put('media/products/chairs/a.jpg', a, {
      'x-width': '800',
      'x-height': '600',
    });
    expect(res.status).toBe(200);
    const stored = h.media.objects.get('media/products/chairs/a.jpg');
    expect(stored?.contentType).toBe('image/jpeg');
    expect(stored?.customMetadata?.source).toBe('photonrelic');
    expect(stored?.customMetadata?.uploadedBy).toBe(STAFF.email);

    const asset = await getAsset(h.db, 'media/products/chairs/a.jpg');
    expect(asset).toMatchObject({
      subject: 'products/chairs',
      source: 'upload',
      width: 800,
      height: 600,
      uploaded_by: STAFF.email,
    });
    expect((await recentActions(h.db))[0]?.action).toBe('library.uploaded');
  });

  it('answers duplicate, same-file, name-taken, bad-name and too-big before any bytes move', async () => {
    const h = harness();
    const a = bytes('image-a');
    await h.put('media/products/a.jpg', a);
    const pre = await h.precheck([
      { key: 'media/products/a.jpg', body: a },
      { key: 'media/other/a-copy.jpg', body: a },
      { key: 'media/products/a.jpg', body: bytes('different') },
      { key: 'media/Products/B.JPG', body: bytes('b') },
      { key: 'media/b.jpg', body: bytes('b') },
    ]);
    expect(pre.answers.map((x) => x.status)).toEqual([
      'same-file',
      'duplicate',
      'name-taken',
      'bad-name',
      'bad-name',
    ]);
    expect(pre.answers[1]?.existingKey).toBe('media/products/a.jpg');

    const big = await h.req('/library/precheck', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entries: [{ key: 'media/x/big.jpg', sha256: 'a'.repeat(64), size: 20_000_000 }],
      }),
    });
    expect(((await big.json()) as { answers: { status: string }[] }).answers[0]?.status).toBe(
      'too-big',
    );
  });

  it('a duplicate within one batch is caught too', async () => {
    const h = harness();
    const a = bytes('same');
    const pre = await h.precheck([
      { key: 'media/x/one.jpg', body: a },
      { key: 'media/x/two.jpg', body: a },
    ]);
    expect(pre.answers.map((x) => x.status)).toEqual(['ok', 'duplicate']);
  });

  it('never overwrites a key, and completes the record when the same bytes come again', async () => {
    const h = harness();
    const a = bytes('image-a');
    await h.put('media/x/a.jpg', a);
    const clash = await h.put('media/x/a.jpg', bytes('other'));
    expect(clash.status).toBe(409);

    // The first attempt stored the object but its record was lost.
    await h.db.prepare('DELETE FROM assets').run();
    const again = await h.put('media/x/a.jpg', a);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { completed?: boolean }).completed).toBe(true);
    expect((await getAsset(h.db, 'media/x/a.jpg'))?.subject).toBe('x');
  });

  it('refuses a bad key, a missing hash and an oversize body', async () => {
    const h = harness();
    expect((await h.put('media/x/A.jpg', bytes('a'))).status).toBe(400);
    expect((await h.put('legacy/x/a.jpg', bytes('a'))).status).toBe(400);
    const noHash = await h.req('/library/upload/media/x/a.jpg', {
      method: 'PUT',
      body: bytes('a'),
      headers: { 'content-length': '1' },
    });
    expect(noHash.status).toBe(400);
    const big = await h.req('/library/upload/media/x/a.jpg', {
      method: 'PUT',
      body: bytes('a'),
      headers: { 'content-length': '20000000', 'x-sha256': 'a'.repeat(64) },
    });
    expect(big.status).toBe(413);
  });

  it('turns uploads off without a bucket', async () => {
    const h = harness({ media: null });
    expect((await h.put('media/x/a.jpg', bytes('a'))).status).toBe(503);
    expect(await (await h.req('/library/upload')).text()).toContain('No media bucket');
  });
});

describe('capture', () => {
  const entry = {
    capturedAt: '2026-05-04T13:22:10',
    camera: 'Canon EOS R5',
    lens: 'RF24-70mm F2.8 L IS USM',
    originalWidth: 6000,
    originalHeight: 4000,
  };
  const header = (o: unknown) => encodeURIComponent(JSON.stringify(o));

  it('reads the header, ignores unknown keys and drops a bad field on its own', () => {
    expect(parseCaptureHeader(undefined)).toEqual({ capture: null, problems: [] });
    expect(parseCaptureHeader('')).toEqual({ capture: null, problems: [] });
    expect(parseCaptureHeader(header({ ...entry, gps: '51.5,-0.1', serial: '1' }))).toEqual({
      capture: entry,
      problems: [],
    });
    // Dates as a camera writes them, with or without a time, with an offset when it gave one.
    for (const ok of ['2026-05-04', '2026-05-04T13:22', '2026-05-04T13:22:10.500+02:00'])
      expect(parseCaptureHeader(header({ capturedAt: ok })).capture).toEqual({ capturedAt: ok });
    const bad = parseCaptureHeader(
      header({
        capturedAt: '2026:05:04 13:22:10',
        camera: ' Leica Q3 ',
        lens: 'x'.repeat(121),
        originalWidth: 6000,
        originalHeight: 'tall',
      }),
    );
    expect(bad.capture).toEqual({ camera: 'Leica Q3' });
    expect(bad.problems).toEqual([
      'capturedAt: not an ISO 8601 date.',
      'lens: not a short line of text.',
      'originalHeight: not a whole number of pixels.',
      'originalWidth and originalHeight go together.',
    ]);
    expect(parseCaptureHeader(header({ camera: 'bad\u0000name' })).capture).toBeNull();
    expect(
      parseCaptureHeader(header({ originalWidth: 0, originalHeight: 1.5 })).capture,
    ).toBeNull();
    expect(parseCaptureHeader(header({ camera: 'Leica' })).capture).toEqual({ camera: 'Leica' });
  });

  it('drops a header it cannot read, with a reason, rather than failing', () => {
    expect(parseCaptureHeader('%7B').problems).toEqual(['X-Capture is not percent-encoded JSON.']);
    expect(parseCaptureHeader('%E0%A4%A').problems).toEqual([
      'X-Capture is not percent-encoded JSON.',
    ]);
    expect(parseCaptureHeader(header([1, 2])).problems).toEqual([
      'X-Capture is not a JSON object.',
    ]);
    expect(parseCaptureHeader(header('text')).problems).toEqual([
      'X-Capture is not a JSON object.',
    ]);
    expect(parseCaptureHeader(header(null)).problems).toEqual(['X-Capture is not a JSON object.']);
    const long = parseCaptureHeader(header({ camera: 'x'.repeat(3000) }));
    expect(long.capture).toBeNull();
    expect(long.problems[0]).toContain('over');
  });

  it('records the fields with the upload and keeps them through a retry without them', async () => {
    const h = harness();
    const a = bytes('image-a');
    const res = await h.put('media/products/chairs/a.jpg', a, {
      'x-width': '2048',
      'x-height': '1365',
      'x-capture': header(entry),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { warnings?: string[] }).not.toHaveProperty('warnings');
    expect(await getAsset(h.db, 'media/products/chairs/a.jpg')).toMatchObject({
      captured_at: '2026-05-04T13:22:10',
      camera: 'Canon EOS R5',
      lens: 'RF24-70mm F2.8 L IS USM',
      original_width: 6000,
      original_height: 4000,
    });
    const page = await (await h.req('/library/file?key=media%2Fproducts%2Fchairs%2Fa.jpg')).text();
    expect(page).toContain('<h4>Capture</h4>');
    expect(page).toContain('2026-05-04 13:22');
    expect(page).toContain('Canon EOS R5');
    expect(page).toContain('RF24-70mm F2.8 L IS USM');
    expect(page).toContain('6000 × 4000 · stored at 2048 × 1365');

    // The same bytes again, from a retry that read no EXIF: the record is not blanked.
    const again = await h.put('media/products/chairs/a.jpg', a);
    expect(((await again.json()) as { completed?: boolean }).completed).toBe(true);
    expect(await getAsset(h.db, 'media/products/chairs/a.jpg')).toMatchObject({
      captured_at: '2026-05-04T13:22:10',
      camera: 'Canon EOS R5',
      original_width: 6000,
    });
  });

  it('uploads normally without the header, or with one it cannot use', async () => {
    const h = harness();
    const plain = await h.put('media/x/plain.jpg', bytes('plain'));
    expect(plain.status).toBe(200);
    const asset = await getAsset(h.db, 'media/x/plain.jpg');
    expect(asset).toMatchObject({
      captured_at: null,
      camera: null,
      lens: null,
      original_width: null,
    });
    expect(await (await h.req('/library/file?key=media%2Fx%2Fplain.jpg')).text()).not.toContain(
      '<h4>Capture</h4>',
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const odd = await h.put('media/x/odd.jpg', bytes('odd'), { 'x-capture': 'not%20json' });
    expect(odd.status).toBe(200);
    expect(((await odd.json()) as { warnings?: string[] }).warnings).toEqual([
      'X-Capture is not percent-encoded JSON.',
    ]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    expect((await getAsset(h.db, 'media/x/odd.jpg'))?.source).toBe('upload');

    // Rescan knows nothing about EXIF: a file found in the bucket has no capture data.
    await h.media.put('media/x/found.jpg', bytes('found'), 'image/jpeg');
    await h.form('/library/rescan', []);
    expect((await getAsset(h.db, 'media/x/found.jpg'))?.captured_at).toBeNull();
  });
});

describe('browse, file and filing', () => {
  it('lists the roots, then folders and tiles from the bucket itself', async () => {
    const h = harness();
    await h.media.put('media/products/a.jpg', bytes('a'), 'image/jpeg');
    await h.media.put('media/products/notes.txt', bytes('n'), 'text/plain');
    const roots = await (await h.req('/library')).text();
    expect(roots).toContain('?prefix=media%2F');
    expect(roots).toContain('?prefix=legacy%2F');
    const folder = await (await h.req('/library?prefix=media/products/')).text();
    expect(folder).toContain('a.jpg');
    expect(folder).not.toContain('notes.txt');
    expect(folder).toContain('https://img.example.com/media/products/a.jpg?w=320&amp;f=auto');
    expect((await h.req('/library?prefix=../')).status).toBe(302);
    expect((await h.req('/library?prefix=private/')).status).toBe(302);
  });

  it('previews through /library/raw when no resizer is configured', async () => {
    const h = harness({ mediaOrigin: null });
    await h.media.put('media/products/a.jpg', bytes('a'), 'image/jpeg');
    const html = await (await h.req('/library?prefix=media/products/')).text();
    expect(html).toContain('/library/raw?key=media%2Fproducts%2Fa.jpg');
    const raw = await h.req('/library/raw?key=media/products/a.jpg');
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe('a');
    expect((await h.req('/library/raw?key=private/a.jpg')).status).toBe(404);
  });

  it('offers copy-ready markup on the file page when the resizer is configured', async () => {
    const h = harness();
    await h.put('media/products/a.jpg', bytes('a'), { 'x-width': '800', 'x-height': '600' });
    const html = await (await h.req('/library/file?key=media/products/a.jpg')).text();
    expect(html).toContain('id="pr-markup"');
    expect(html).toContain('/static/pr-markup.js');
    expect(html).toContain('data-origin="https://img.example.com"');
    expect(html).toContain('data-width="800"');
    // The default widths are ticked; the rest of the menu is offered.
    expect(html).toContain('name="w" value="768" checked');
    expect(html).toContain('name="w" value="160"');
    expect(html).not.toContain('name="w" value="160" checked');
    expect(html).toContain('<option value="16:9">');
    // The first rendering: avif and webp sources, a jpeg fallback, the source's size scaled.
    expect(html).toContain('&lt;picture&gt;');
    expect(html).toContain(
      'https://img.example.com/media/products/a.jpg?w=480&amp;amp;f=avif 480w',
    );
    expect(html).toContain('width=&quot;800&quot; height=&quot;600&quot;');
    expect(html).toContain('No default alt text yet');

    await h.form('/library/file/save', [
      ['key', 'media/products/a.jpg'],
      ['alt_default', 'A "good" chair'],
    ]);
    const filed = await (await h.req('/library/file?key=media/products/a.jpg')).text();
    expect(filed).not.toContain('No default alt text yet');
    // The builder's entities, escaped once more by the page: the textarea shows alt="A &quot;good&quot; chair".
    expect(filed).toContain('alt=&quot;A &amp;quot;good&amp;quot; chair&quot;');
  });

  it('offers the whole menu when none of the default widths is on it', async () => {
    const h = harness({ menu: menuFromLists('320, 640', '2:1') });
    await h.media.put('media/x/a.jpg', bytes('a'), 'image/jpeg');
    const html = await (await h.req('/library/file?key=media/x/a.jpg')).text();
    expect(html).toContain('name="w" value="320" checked');
    expect(html).toContain('name="w" value="640" checked');
    expect(html).not.toContain('value="768"');
    expect(html).toContain('<option value="2:1">');
    expect(html).not.toContain('<option value="16:9">');
  });

  it('says the markup needs the resizer when none is configured', async () => {
    const h = harness({ mediaOrigin: null });
    await h.media.put('media/x/a.jpg', bytes('a'), 'image/jpeg');
    const html = await (await h.req('/library/file?key=media/x/a.jpg')).text();
    expect(html).toContain('Embed markup needs the resizer');
    expect(html).not.toContain('id="pr-markup"');
    expect(html).not.toContain('pr-markup.js');
  });

  it('saves a file page and bulk-files with a preview step', async () => {
    const h = harness();
    await h.media.put('legacy/one.jpg', bytes('1'), 'image/jpeg');
    await h.media.put('legacy/two-up.jpg', bytes('2'), 'image/jpeg');
    await h.form('/library/rescan', []);

    const save = await h.form('/library/file/save', [
      ['key', 'legacy/one.jpg'],
      ['subject', '/products/'],
      ['tags', 'Hero Shot, detail'],
      ['alt_default', 'A chair'],
      ['credit', 'Studio'],
    ]);
    expect(save.status).toBe(303);
    expect(await getAsset(h.db, 'legacy/one.jpg')).toMatchObject({
      subject: 'products',
      tags: ['detail', 'hero-shot'],
      alt_default: 'A chair',
      credit: 'Studio',
      filed_by: STAFF.email,
    });

    const fields: [string, string][] = [
      ['keys', 'legacy/one.jpg'],
      ['keys', 'legacy/two-up.jpg'],
      ['keys', 'private/nope.jpg'],
      ['add_tags', 'archive'],
      ['alt_pattern', 'Archive photo, {name}'],
      ['back', '/library?prefix=legacy/'],
    ];
    const preview = await h.form('/library/bulk', fields);
    const previewHtml = await preview.text();
    expect(previewHtml).toContain('File 2 files');
    expect(previewHtml).toContain('Archive photo, two up');

    const apply = await h.form('/library/bulk/apply', fields);
    expect(apply.headers.get('location')).toBe('/library?prefix=legacy/');
    expect((await getAsset(h.db, 'legacy/two-up.jpg'))?.tags).toEqual(['archive']);
    expect((await getAsset(h.db, 'legacy/one.jpg'))?.tags).toEqual([
      'archive',
      'detail',
      'hero-shot',
    ]);
  });

  it('keeps the back link on the library', async () => {
    const h = harness();
    await h.media.put('media/x/a.jpg', bytes('a'), 'image/jpeg');
    const res = await h.form('/library/bulk', [
      ['keys', 'media/x/a.jpg'],
      ['back', 'https://evil.example.net/'],
    ]);
    expect(res.headers.get('location')).toBe('/library');
  });

  it('retires and un-retires without touching the object', async () => {
    const h = harness();
    await h.put('media/x/a.jpg', bytes('a'));
    await h.form('/library/file/retire', [
      ['key', 'media/x/a.jpg'],
      ['retired', '1'],
      ['note', 'reshot'],
    ]);
    expect(await getAsset(h.db, 'media/x/a.jpg')).toMatchObject({
      retired: true,
      retired_note: 'reshot',
    });
    expect(h.media.objects.has('media/x/a.jpg')).toBe(true);
    await h.form('/library/file/retire', [
      ['key', 'media/x/a.jpg'],
      ['retired', '0'],
    ]);
    expect((await getAsset(h.db, 'media/x/a.jpg'))?.retired).toBe(false);
  });
});

describe('replace', () => {
  const KEY = 'media/products/chairs/a.jpg';
  /** An upload, filed and tagged, so a replace has something to keep. */
  async function filed(h: ReturnType<typeof harness>) {
    await h.put(KEY, jpeg('first'), { 'x-width': '800', 'x-height': '600' });
    await h.form('/library/file/save', [
      ['key', KEY],
      ['subject', 'products/chairs'],
      ['tags', 'hero'],
      ['alt_default', 'A chair'],
      ['credit', 'Studio'],
    ]);
    return await getAsset(h.db, KEY);
  }

  it('sniffs the web formats and nothing else', () => {
    expect(sniffImageType(jpeg('x'))).toBe('image/jpeg');
    expect(sniffImageType(png('x'))).toBe('image/png');
    expect(sniffImageType(bytes('GIF89a....'))).toBe('image/gif');
    expect(sniffImageType(bytes('RIFF....WEBPVP8 '))).toBe('image/webp');
    expect(
      sniffImageType(new Uint8Array([0, 0, 0, 28, ...new TextEncoder().encode('ftypavif')]).buffer),
    ).toBe('image/avif');
    expect(
      sniffImageType(
        new Uint8Array([
          0,
          0,
          0,
          24,
          ...new TextEncoder().encode('ftypmif1'),
          0,
          0,
          0,
          0,
          ...new TextEncoder().encode('avif'),
        ]).buffer,
      ),
    ).toBe('image/avif');
    expect(sniffImageType(bytes('<svg xmlns'))).toBeNull();
    expect(sniffImageType(bytes(''))).toBeNull();
  });

  it('prechecks: ok, the same bytes, too big, a missing object, a key it cannot replace', async () => {
    const h = harness();
    await filed(h);
    expect((await h.replacePrecheck(KEY, jpeg('second'))).answer.status).toBe('ok');
    expect((await h.replacePrecheck(KEY, jpeg('first'))).answer.status).toBe('same-file');
    expect((await h.replacePrecheck('media/products/none.jpg', jpeg('x'))).answer.status).toBe(
      'missing',
    );
    expect((await h.replacePrecheck('private/a.jpg', jpeg('x'))).answer.status).toBe('bad-name');
    expect((await h.replacePrecheck('media/x/a.heic', jpeg('x'))).answer.status).toBe('bad-name');
    const big = await h.req('/library/file/replace/precheck', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: KEY, sha256: 'a'.repeat(64), size: 20_000_000 }),
    });
    expect(((await big.json()) as { answer: { status: string } }).answer.status).toBe('too-big');
    const malformed = await h.req('/library/file/replace/precheck', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: KEY }),
    });
    expect(malformed.status).toBe(400);
  });

  it('refuses the same bytes, a hash that does not match, and bytes of another format', async () => {
    const h = harness();
    await filed(h);
    expect((await h.replace(KEY, jpeg('first'))).status).toBe(409);
    const lied = await h.replace(KEY, jpeg('second'), { 'x-sha256': await sha256(jpeg('other')) });
    expect(lied.status).toBe(400);
    expect(((await lied.json()) as { error: string }).error).toMatch(/do not match/);
    const wrongFormat = await h.replace(KEY, png('second'));
    expect(wrongFormat.status).toBe(415);
    expect(((await wrongFormat.json()) as { error: string }).error).toMatch(/image\/png/);
    expect((await h.replace('media/products/none.jpg', jpeg('x'))).status).toBe(404);
    expect((await h.replace('private/a.jpg', jpeg('x'))).status).toBe(400);
    const big = await h.req(`/library/file/replace?key=${encodeURIComponent(KEY)}`, {
      method: 'PUT',
      body: jpeg('x'),
      headers: { 'content-length': '20000000', 'x-sha256': 'a'.repeat(64) },
    });
    expect(big.status).toBe(413);
    // Nothing above touched the object.
    expect(h.media.objects.get(KEY)?.customMetadata?.sha256).toBe(await sha256(jpeg('first')));
    expect((await recentActions(h.db)).some((e) => e.action === 'library.replaced')).toBe(false);
  });

  it('writes over the key, keeps the filing, audits, purges and flashes', async () => {
    const purge = fakePurge();
    const h = harness({ purge: purge.config });
    const before = await filed(h);
    const next = jpeg('second');
    const res = await h.replace(KEY, next, { 'x-width': '1200', 'x-height': '900' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; purge: { urls: number } };
    expect(body.ok).toBe(true);
    expect(body.purge.urls).toBe(127);

    const stored = h.media.objects.get(KEY);
    expect(new Uint8Array(stored?.bytes ?? new ArrayBuffer(0))).toEqual(new Uint8Array(next));
    expect(stored?.customMetadata).toMatchObject({
      sha256: await sha256(next),
      uploadedBy: STAFF.email,
    });

    const after = await getAsset(h.db, KEY);
    expect(after).toMatchObject({
      subject: 'products/chairs',
      tags: ['hero'],
      alt_default: 'A chair',
      credit: 'Studio',
      first_seen: before?.first_seen,
      sha256: await sha256(next),
      etag: stored?.etag,
      bytes: next.byteLength,
      width: 1200,
      height: 900,
      source: 'upload',
      uploaded_by: STAFF.email,
    });
    expect(after?.etag).not.toBe(before?.etag);

    const audit = (await recentActions(h.db))[0];
    expect(audit).toMatchObject({ action: 'library.replaced', actor: STAFF.email, ok: true });
    expect(audit?.detail).toEqual({
      key: KEY,
      from: await sha256(jpeg('first')),
      to: await sha256(next),
      bytes: next.byteLength,
    });
    expect(purge.urls()).toEqual(variantUrls('https://img.example.com', KEY));
    expect(purge.calls).toHaveLength(5);
    expect(flashOf(res)).toBe(
      `Replaced ${KEY}. Cached copies purged. Your own browser may keep its copy for up to an hour.`,
    );
  });

  it('replaces a retired or unfiled key found in the bucket, keeping the retired state', async () => {
    const h = harness();
    await h.media.put('legacy/old.jpg', jpeg('found'), 'image/jpeg');
    await h.form('/library/rescan', []);
    await h.form('/library/file/retire', [
      ['key', 'legacy/old.jpg'],
      ['retired', '1'],
      ['note', 'reshot'],
    ]);
    expect((await h.replace('legacy/old.jpg', jpeg('reshoot'))).status).toBe(200);
    expect(await getAsset(h.db, 'legacy/old.jpg')).toMatchObject({
      retired: true,
      retired_note: 'reshot',
      subject: null,
      source: 'upload',
      sha256: await sha256(jpeg('reshoot')),
    });
  });

  it('forgets the old bytes’ capture data', async () => {
    const h = harness();
    await h.put(KEY, jpeg('first'), {
      'x-width': '800',
      'x-height': '600',
      'x-capture': encodeURIComponent(
        JSON.stringify({ capturedAt: '2026-05-04T13:22:10', camera: 'Canon EOS R5' }),
      ),
    });
    await h.form('/library/file/save', [
      ['key', KEY],
      ['subject', 'products/chairs'],
    ]);
    expect(await getAsset(h.db, KEY)).toMatchObject({
      captured_at: '2026-05-04T13:22:10',
      camera: 'Canon EOS R5',
    });
    expect((await h.replace(KEY, jpeg('second'))).status).toBe(200);
    expect(await getAsset(h.db, KEY)).toMatchObject({
      subject: 'products/chairs',
      captured_at: null,
      camera: null,
      lens: null,
      original_width: null,
      original_height: null,
    });
  });

  it('says so without a purge, and logs a failed purge without failing the replace', async () => {
    const h = harness();
    await filed(h);
    const plain = await h.replace(KEY, jpeg('second'));
    expect(flashOf(plain)).toContain('Cached copies refresh within a day.');

    const refused = fakePurge(() =>
      Response.json(
        { success: false, errors: [{ message: 'Authentication error' }] },
        { status: 403 },
      ),
    );
    const h2 = harness({ purge: refused.config });
    await filed(h2);
    const res = await h2.replace(KEY, jpeg('second'));
    expect(res.status).toBe(200);
    expect(flashOf(res)).toContain('The purge failed (Authentication error)');
    const [failed, replaced] = await recentActions(h2.db);
    expect(failed).toMatchObject({ action: 'library.purge', ok: false });
    expect(failed?.detail).toMatchObject({ keys: [KEY], urls: 127, purged: 0 });
    expect(replaced?.action).toBe('library.replaced');
  });

  it('shows the Replace section on the file page, but not for a retired file', async () => {
    const h = harness();
    await filed(h);
    const html = await (await h.req(`/library/file?key=${KEY}`)).text();
    expect(html).toContain('id="pr-replace"');
    expect(html).toContain('accept=".jpg,.jpeg"');
    expect(html).toContain('/static/pr-upload.js');
    await h.form('/library/file/retire', [
      ['key', KEY],
      ['retired', '1'],
    ]);
    expect(await (await h.req(`/library/file?key=${KEY}`)).text()).not.toContain('id="pr-replace"');
  });
});

describe('delete', () => {
  it('purges the stored URL and every variant once the object is gone', async () => {
    const purge = fakePurge();
    const h = harness({ purge: purge.config });
    await h.put('media/x/a.jpg', bytes('a'));
    const res = await h.form('/library/file/delete', [
      ['key', 'media/x/a.jpg'],
      ['confirm', 'delete'],
    ]);
    expect(h.media.objects.has('media/x/a.jpg')).toBe(false);
    expect(purge.urls()).toEqual(variantUrls('https://img.example.com', 'media/x/a.jpg'));
    expect(purge.urls()[0]).toBe('https://img.example.com/media/x/a.jpg');
    expect(flashOf(res)).toBe('Deleted media/x/a.jpg from the bucket. Cached copies purged.');
  });

  it('needs the confirmation, then removes the object and forgets it', async () => {
    const h = harness();
    await h.put('media/x/a.jpg', bytes('a'));
    const unconfirmed = await h.form('/library/file/delete', [['key', 'media/x/a.jpg']]);
    expect(unconfirmed.status).toBe(303);
    expect(h.media.objects.has('media/x/a.jpg')).toBe(true);

    const done = await h.form('/library/file/delete', [
      ['key', 'media/x/a.jpg'],
      ['confirm', 'delete'],
    ]);
    expect(done.headers.get('location')).toBe('/library?prefix=media%2Fx%2F');
    expect(h.media.objects.has('media/x/a.jpg')).toBe(false);
    expect(await getAsset(h.db, 'media/x/a.jpg')).toBeNull();
    expect((await recentActions(h.db))[0]).toMatchObject({
      action: 'library.deleted',
      actor: STAFF.email,
    });
  });

  it('refuses a key outside the library', async () => {
    const h = harness();
    await h.media.put('private/a.jpg', bytes('a'), 'image/jpeg');
    await h.form('/library/file/delete', [
      ['key', 'private/a.jpg'],
      ['confirm', 'delete'],
    ]);
    expect(h.media.objects.has('private/a.jpg')).toBe(true);
  });
});

describe('rescan, unfiled and duplicates', () => {
  it('notes new keys as unfiled, completes cut-off uploads and forgets gone objects', async () => {
    const h = harness();
    await h.media.put('legacy/found.jpg', bytes('f'), 'image/jpeg');
    // Stored by an upload whose record was never written.
    await h.media.put('media/products/cut.jpg', bytes('c'), 'image/jpeg', {
      customMetadata: {
        source: 'photonrelic',
        sha256: 'b'.repeat(64),
        uploadedBy: 'x@example.com',
      },
    });
    await h.db
      .prepare(
        "INSERT INTO assets (key, source, first_seen) VALUES ('media/gone.jpg', 'other', 'x')",
      )
      .run();
    const res = await h.form('/library/rescan', []);
    expect(res.status).toBe(303);
    expect(await getAsset(h.db, 'media/gone.jpg')).toBeNull();
    expect(await getAsset(h.db, 'legacy/found.jpg')).toMatchObject({
      subject: null,
      source: 'other',
    });
    expect(await getAsset(h.db, 'media/products/cut.jpg')).toMatchObject({
      subject: 'products',
      source: 'upload',
      uploaded_by: 'x@example.com',
    });
    const unfiled = await (await h.req('/library/unfiled')).text();
    expect(unfiled).toContain('found.jpg');
    expect(unfiled).not.toContain('cut.jpg');
  });

  it('notices a key whose bytes were replaced outside, forgets what it knew of them, and purges', async () => {
    const purge = fakePurge();
    const h = harness({ purge: purge.config });
    await h.put('media/x/a.jpg', jpeg('first'), { 'x-width': '800', 'x-height': '600' });
    await h.put('media/x/same.jpg', jpeg('same'));
    await h.form('/library/file/save', [
      ['key', 'media/x/a.jpg'],
      ['subject', 'x'],
      ['tags', 'hero'],
    ]);
    // rclone wrote over it: no stamp, a new etag.
    await h.media.put('media/x/a.jpg', jpeg('second'), 'image/jpeg');
    const res = await h.form('/library/rescan', []);
    expect(flashOf(res)).toContain('1 changed (bytes replaced outside). Cached copies purged.');
    expect(await getAsset(h.db, 'media/x/a.jpg')).toMatchObject({
      etag: h.media.objects.get('media/x/a.jpg')?.etag,
      bytes: jpeg('second').byteLength,
      sha256: null,
      width: null,
      height: null,
      subject: 'x',
      tags: ['hero'],
    });
    expect((await getAsset(h.db, 'media/x/same.jpg'))?.sha256).toBe(await sha256(jpeg('same')));
    expect(purge.urls()).toEqual(variantUrls('https://img.example.com', 'media/x/a.jpg'));
    const actions = await recentActions(h.db);
    expect(actions[0]).toMatchObject({ action: 'library.changed' });
    expect(actions[0]?.detail).toEqual({ keys: ['media/x/a.jpg'] });
    expect(actions[1]).toMatchObject({ action: 'library.rescan' });
    expect(actions[1]?.detail).toMatchObject({ changed: 1, listed: 2 });

    // A second rescan with nothing changed purges nothing.
    await h.form('/library/rescan', []);
    expect(purge.calls).toHaveLength(5);
  });

  it('purges only the first few keys a rescan finds changed, and says so', async () => {
    const purge = fakePurge();
    const h = harness({ purge: purge.config });
    const keys = Array.from({ length: 10 }, (_, i) => `media/x/${i}.jpg`);
    for (const k of keys) await h.put(k, jpeg(k));
    // A resync wrote over all of them.
    for (const k of keys) await h.media.put(k, jpeg(`${k} again`), 'image/jpeg');
    const res = await h.form('/library/rescan', []);
    expect(flashOf(res)).toContain('10 changed (bytes replaced outside).');
    expect(flashOf(res)).toContain(
      'Cached copies purged for the first 8 changed keys; the rest refresh within a day.',
    );
    const purged = new Set(
      purge.urls().map((u) => decodeURIComponent(new URL(u).pathname.slice(1))),
    );
    expect(purged.size).toBe(8);
    expect(purge.urls().length).toBe(
      8 * variantUrls('https://img.example.com', 'media/x/0.jpg').length,
    );
  });

  it('completes a replace that was cut off before its record, from the object’s own stamp', async () => {
    const h = harness();
    await h.put('media/x/a.jpg', jpeg('first'));
    await h.media.put('media/x/a.jpg', jpeg('second'), 'image/jpeg', {
      customMetadata: {
        source: 'photonrelic',
        sha256: await sha256(jpeg('second')),
        uploadedBy: 'other@example.com',
      },
    });
    await h.form('/library/rescan', []);
    expect(await getAsset(h.db, 'media/x/a.jpg')).toMatchObject({
      sha256: await sha256(jpeg('second')),
      uploaded_by: 'other@example.com',
      source: 'upload',
    });
  });

  it('groups keys with the same bytes and retires all but the kept one', async () => {
    const h = harness();
    const same = bytes('same');
    await h.media.put('media/a/one.jpg', same, 'image/jpeg');
    await h.media.put('legacy/two.jpg', same, 'image/jpeg');
    await noteSeen(
      h.db,
      h.deps.layout,
      (await h.media.list('media/a/')).objects.concat((await h.media.list('legacy/')).objects),
      new Date(),
    );
    const groups = await listDuplicates(h.db);
    expect(groups).toHaveLength(1);
    const hash = groups[0]?.hash ?? '';
    expect((await h.req('/library/duplicates')).status).toBe(200);
    await h.form('/library/duplicates/resolve', [
      ['hash', hash],
      ['keep', 'media/a/one.jpg'],
    ]);
    expect(await getAsset(h.db, 'legacy/two.jpg')).toMatchObject({
      retired: true,
      retired_note: 'duplicate of media/a/one.jpg',
    });
    expect(await listDuplicates(h.db)).toHaveLength(0);
  });
});

describe('usage', () => {
  it('says the file page is not configured without a reader, and the Unused view too', async () => {
    const h = harness();
    await h.put('media/x/a.jpg', bytes('a'));
    const file = await (await h.req('/library/file?key=media/x/a.jpg')).text();
    expect(file).toContain('Not configured');
    expect(file).not.toContain('hits, 7 days');
    const unused = await (await h.req('/library/unused')).text();
    expect(unused).toContain('Usage is not configured');
  });

  it('shows the counts on the file page and warns before retiring or deleting a used file', async () => {
    const h = harness({
      usage: new FakeUsage({ 'media/x/used.jpg': { d7: 3, d30: 41 } }),
    });
    await h.put('media/x/used.jpg', bytes('u'));
    await h.put('media/x/idle.jpg', bytes('i'));

    const used = await (await h.req('/library/file?key=media/x/used.jpg')).text();
    expect(used).toContain('hits, 7 days');
    expect(used).toMatch(/<span class="stat-value">3<\/span>/);
    expect(used).toMatch(/<span class="stat-value">41<\/span>/);
    expect(used.match(/something still uses this file/g)).toHaveLength(2);
    expect(used).toContain('Deleting it breaks those pages');

    const idle = await (await h.req('/library/file?key=media/x/idle.jpg')).text();
    expect(idle).toMatch(/<span class="stat-value">0<\/span>/);
    expect(idle).not.toContain('something still uses this file');
  });

  it('keeps the file page up when the engine is down', async () => {
    const h = harness({ usage: new BrokenUsage() });
    await h.put('media/x/a.jpg', bytes('a'));
    const res = await h.req('/library/file?key=media/x/a.jpg');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Usage unavailable: SQL API answered 500');
    const unused = await h.req('/library/unused');
    expect(unused.status).toBe(200);
    expect(await unused.text()).toContain('Could not read the usage dataset');
  });

  it('lists the known, unretired files with no hits, oldest first, a page at a time', async () => {
    const h = harness({ usage: new FakeUsage({ 'media/x/used.jpg': { d7: 0, d30: 2 } }) });
    await h.put('media/x/used.jpg', bytes('u'));
    await h.put('media/x/idle.jpg', bytes('i'));
    await h.put('media/x/old.jpg', bytes('o'));
    await h.form('/library/file/retire', [
      ['key', 'media/x/old.jpg'],
      ['retired', '1'],
    ]);
    // A hundred more idle files, seen earlier than the ones above, to fill the first page.
    for (let i = 0; i < 100; i++) {
      await h.db
        .prepare("INSERT INTO assets (key, source, first_seen) VALUES (?1, 'other', ?2)")
        .bind(
          `media/bulk/${String(i).padStart(3, '0')}.jpg`,
          `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
        )
        .run();
    }
    const first = await (await h.req('/library/unused')).text();
    expect(first).toContain('101 unused, page 1 of 2');
    expect(first).toContain('media/bulk/000.jpg');
    expect(first).not.toContain('idle.jpg');
    expect(first).not.toContain('used.jpg');
    expect(first).not.toContain('old.jpg');
    expect(first).toContain('/library/unused?page=2');

    const second = await (await h.req('/library/unused?page=2')).text();
    expect(second).toContain('idle.jpg');
    expect(second).toContain('/library/file?key=media%2Fx%2Fidle.jpg');
    expect(second).not.toContain('media/bulk/000.jpg');
    expect(second).toContain('name="back" value="/library/unused?page=2"');

    expect((await h.req('/library/unused?page=nope')).status).toBe(200);
  });

  it('says so when everything has been served', async () => {
    const h = harness({ usage: new FakeUsage({ 'media/x/a.jpg': { d7: 1, d30: 1 } }) });
    await h.put('media/x/a.jpg', bytes('a'));
    expect(await (await h.req('/library/unused')).text()).toContain(
      'Every file the library knows has been served',
    );
  });
});

describe('focal point', () => {
  const KEY = 'media/portraits/anna.jpg';
  const FILE = `/library/file?key=${encodeURIComponent(KEY)}`;
  const focal = (h: ReturnType<typeof harness>, x: string, y: string) =>
    h.form('/library/file/focal', [
      ['key', KEY],
      ['x', x],
      ['y', y],
    ]);

  it('has two nullable REAL columns on assets', () => {
    const h = harness();
    const cols = h.db.raw.prepare('PRAGMA table_info(assets)').all() as {
      name: string;
      type: string;
      notnull: number;
    }[];
    const focalCols = cols.filter((c) => c.name === 'focal_x' || c.name === 'focal_y');
    expect(focalCols.map((c) => [c.name, c.type, c.notnull])).toEqual([
      ['focal_x', 'REAL', 0],
      ['focal_y', 'REAL', 0],
    ]);
  });

  it('parses fractions from 0 to 1 with up to four decimals, and both empty as automatic', () => {
    expect(parseFocal('0.3333', '0.2')).toEqual({ ok: true, focal: { x: 0.3333, y: 0.2 } });
    expect(parseFocal('0', '1')).toEqual({ ok: true, focal: { x: 0, y: 1 } });
    expect(parseFocal('1.0000', ' 0.5 ')).toEqual({ ok: true, focal: { x: 1, y: 0.5 } });
    expect(parseFocal('', '')).toEqual({ ok: true, focal: null });
    for (const [x, y] of [
      ['0.5', ''],
      ['', '0.5'],
      ['0.33333', '0.2'],
      ['1.0001', '0.2'],
      ['-0.1', '0.2'],
      ['.5', '0.2'],
      ['abc', '0.2'],
      ['0.5', '2'],
      ['1e-1', '0.2'],
    ]) {
      expect(parseFocal(x ?? '', y ?? '').ok, `${x},${y}`).toBe(false);
    }
  });

  it('saves the point, audits it, purges the key and says so', async () => {
    const purge = fakePurge();
    const h = harness({ purge: purge.config });
    await h.put(KEY, jpeg('anna'));
    const res = await focal(h, '0.3700', '0.2200');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(FILE);
    expect(flashOf(res)).toBe('Focal point saved. Cached copies purged.');
    expect(await getAsset(h.db, KEY)).toMatchObject({ focal_x: 0.37, focal_y: 0.22 });
    expect(focalOf(await getAsset(h.db, KEY))).toEqual({ x: 0.37, y: 0.22 });
    const audit = (await recentActions(h.db))[0];
    expect(audit).toMatchObject({ action: 'library.focal', actor: STAFF.email, ok: true });
    expect(audit?.detail).toEqual({ key: KEY, x: 0.37, y: 0.22 });
    expect(purge.urls()).toEqual(variantUrls('https://img.example.com', KEY));
  });

  it('clears to automatic on empty values, with its own audit row and purge', async () => {
    const purge = fakePurge();
    const h = harness({ purge: purge.config });
    await h.put(KEY, jpeg('anna'));
    await focal(h, '0.37', '0.22');
    purge.calls.length = 0;
    const res = await focal(h, '', '');
    expect(flashOf(res)).toBe(
      'Focal point cleared; crops are automatic again. Cached copies purged.',
    );
    expect(await getAsset(h.db, KEY)).toMatchObject({ focal_x: null, focal_y: null });
    expect((await recentActions(h.db))[0]?.detail).toEqual({ key: KEY, x: null, y: null });
    expect(purge.urls()).toEqual(variantUrls('https://img.example.com', KEY));
  });

  it('refuses bad values, a key outside the library and a retired file, changing nothing', async () => {
    const h = harness();
    await h.put(KEY, jpeg('anna'));
    const bad = await focal(h, '0.5', '1.5');
    expect(bad.headers.get('location')).toBe(FILE);
    expect(flashOf(bad)).toContain('fractions from 0 to 1');
    expect(flashOf(await focal(h, '0.5', ''))).toContain('both x and y');
    const outside = await h.form('/library/file/focal', [
      ['key', 'private/x.jpg'],
      ['x', '0.5'],
      ['y', '0.5'],
    ]);
    expect(outside.headers.get('location')).toBe('/library');
    await h.form('/library/file/retire', [
      ['key', KEY],
      ['retired', '1'],
    ]);
    expect(flashOf(await focal(h, '0.5', '0.5'))).toContain('retired');
    expect(await getAsset(h.db, KEY)).toMatchObject({ focal_x: null, focal_y: null });
    expect((await recentActions(h.db)).some((a) => a.action === 'library.focal')).toBe(false);
  });

  it('says so without a purge, and logs a failed purge without failing the save', async () => {
    const h = harness();
    await h.put(KEY, jpeg('anna'));
    expect(flashOf(await focal(h, '0.5', '0.5'))).toBe(
      'Focal point saved. Cached copies refresh within a day.',
    );
    const refused = fakePurge(() => Response.json({ success: false }, { status: 500 }));
    const h2 = harness({ purge: refused.config });
    await h2.put(KEY, jpeg('anna'));
    const res = await focal(h2, '0.5', '0.5');
    expect(flashOf(res)).toContain('The purge failed (HTTP 500)');
    const [failed, saved] = await recentActions(h2.db);
    expect(failed).toMatchObject({ action: 'library.purge', ok: false });
    expect(saved?.action).toBe('library.focal');
    expect(await getAsset(h2.db, KEY)).toMatchObject({ focal_x: 0.5, focal_y: 0.5 });
  });

  it('shows the picker through the resizer, with the stored point and the Automatic button', async () => {
    const h = harness();
    await h.put(KEY, jpeg('anna'));
    let html = await (await h.req(FILE)).text();
    expect(html).toContain('class="focal-pick"');
    expect(html).toContain('action="/library/file/focal"');
    expect(html).toContain(
      `<img src="https://img.example.com/${KEY}?w=1024&amp;f=auto" alt="" draggable="false"/>`,
    );
    expect(html).toContain('name="x" value=""');
    expect(html).toContain('>automatic</td>');
    expect(html).not.toContain('>Automatic</button>');

    await focal(h, '0.37', '0.22');
    html = await (await h.req(FILE)).text();
    expect(html).toContain('name="x" value="0.37"');
    expect(html).toContain('name="y" value="0.22"');
    expect(html).toContain('left:37%;top:22%');
    expect(html).toContain('x 0.3700 · y 0.2200');
    expect(html).toContain('>Automatic</button>');
  });

  it('shows the picker through /library/raw without a resizer, and not for a retired file', async () => {
    const h = harness({ mediaOrigin: null });
    await h.put(KEY, jpeg('anna'));
    const html = await (await h.req(FILE)).text();
    expect(html).toContain('class="focal-pick"');
    expect(html).toContain(`<img src="/library/raw?key=${encodeURIComponent(KEY)}" alt=""`);
    await h.form('/library/file/retire', [
      ['key', KEY],
      ['retired', '1'],
    ]);
    expect(await (await h.req(FILE)).text()).not.toContain('class="focal-pick"');
  });
});

describe('audit', () => {
  it('lists writes newest first', async () => {
    const h = harness();
    await h.put('media/x/a.jpg', bytes('a'));
    await h.form('/library/rescan', []);
    const html = await (await h.req('/audit')).text();
    expect(html.indexOf('library.rescan')).toBeLessThan(html.indexOf('library.uploaded'));
  });
});
