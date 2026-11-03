import { describe, expect, it } from 'vitest';
import { recentActions } from '../src/audit.js';
import {
  DESCRIBE_HEADER_MAX,
  fileAssets,
  getAsset,
  isMasterUrl,
  masterProvider,
  masterUrlIn,
  parseDescribeHeader,
  recordReplace,
  type SearchFilters,
  searchAssets,
} from '../src/library.js';
import { bytes, harness, jpeg, STAFF } from './helpers.js';

const header = (o: unknown) => encodeURIComponent(JSON.stringify(o));
const NOW = new Date('2026-10-30T12:00:00.000Z');
const ALL: SearchFilters = { q: '', subject: null, tag: null, camera: null, state: 'all' };

/** The stock photo's entry, as the prep tool would write it. */
const STOCK = {
  title: 'Man is shocked and surprised with the white mail message or the bill.',
  description: 'Asian man is shocked and surprised with the white mail message or the bill.',
  keywords: ['man', 'Document', 'letter', 'man', 'bill  pay', 'finance'],
  creator: 'Rachata Teyparsit',
  credit: 'Sevendeman - stock.adobe.com',
  copyright: '© 2019 Sevendeman',
  origin: 'Adobe Stock 270140535',
  sourceUrl: 'https://stock.adobe.com/270140535',
  usageTerms: 'Standard license:\nweb and print, no resale',
  license: 'Adobe Stock Standard',
  masterName: 'AdobeStock_270140535.ai',
};

const KEY = 'media/campaigns/billing/adobestock-270140535.jpg';

describe('describe migration', () => {
  it('adds the describe and master columns and indexes the title and creator', () => {
    const h = harness();
    const names = h.db.raw
      .prepare('PRAGMA table_info(assets)')
      .all()
      .map((c) => (c as { name: string }).name);
    for (const col of [
      'title',
      'creator',
      'copyright',
      'origin',
      'master_url',
      'master_name',
      'master_key',
    ])
      expect(names).toContain(col);
    const fts = h.db.raw
      .prepare('PRAGMA table_info(assets_fts)')
      .all()
      .map((c) => (c as { name: string }).name);
    expect(fts).toEqual([
      'key',
      'subject',
      'tags',
      'alt_default',
      'credit',
      'camera',
      'lens',
      'title',
      'creator',
    ]);
  });
});

describe('the X-Describe header', () => {
  it('takes the fields, normalizes keywords as tags and ignores what it does not know', () => {
    expect(parseDescribeHeader(undefined)).toEqual({ describe: null, problems: [] });
    expect(parseDescribeHeader('')).toEqual({ describe: null, problems: [] });
    const r = parseDescribeHeader(
      header({ ...STOCK, gps: '13.7,100.5', title: ' Two  lines\nhere ' }),
    );
    expect(r.problems).toEqual([]);
    expect(r.describe).toEqual({
      ...STOCK,
      title: 'Two lines here',
      keywords: ['man', 'document', 'letter', 'bill-pay', 'finance'],
    });
  });

  it('drops a bad field on its own and says why', () => {
    const r = parseDescribeHeader(
      header({
        title: 'x'.repeat(301),
        creator: 'bad\u0000name',
        sourceUrl: 'ftp://example.com/a',
        keywords: 'not a list',
        usageTerms: 'ok\nwith lines',
        copyright: '© Someone',
      }),
    );
    expect(r.describe).toEqual({ copyright: '© Someone', usageTerms: 'ok\nwith lines' });
    expect(r.problems).toEqual([
      'title: not text under 300 characters.',
      'creator: not text under 200 characters.',
      'sourceUrl: not an http(s) URL.',
      'keywords: not a list of words.',
    ]);
    expect(parseDescribeHeader('%7B').problems).toEqual([
      'X-Describe is not percent-encoded JSON.',
    ]);
    expect(parseDescribeHeader(header([1])).problems).toEqual(['X-Describe is not a JSON object.']);
    const long = parseDescribeHeader(header({ title: 'x'.repeat(DESCRIBE_HEADER_MAX) }));
    expect(long.describe).toBeNull();
    expect(long.problems[0]).toContain('over');
    // A hundred and one keywords: the first hundred that survive the rules.
    const many = parseDescribeHeader(
      header({ keywords: Array.from({ length: 101 }, (_, i) => `k${i}`) }),
    );
    expect(many.describe?.keywords).toHaveLength(100);
  });
});

describe('an upload seeds the record from what the file said', () => {
  it('fills the empty fields, shows them on the file page, and audits what arrived', async () => {
    const h = harness();
    const res = await h.put(KEY, bytes('stock'), { 'x-describe': header(STOCK) });
    expect(res.status).toBe(200);
    expect((await res.json()) as { warnings?: string[] }).not.toHaveProperty('warnings');
    expect(await getAsset(h.db, KEY)).toMatchObject({
      title: STOCK.title,
      alt_default: STOCK.description,
      tags: ['bill-pay', 'document', 'finance', 'letter', 'man'].sort(),
      creator: STOCK.creator,
      credit: STOCK.credit,
      copyright: STOCK.copyright,
      origin: STOCK.origin,
      source_url: STOCK.sourceUrl,
      restrictions: STOCK.usageTerms,
      license: STOCK.license,
      master_name: STOCK.masterName,
      master_url: null,
      master_key: null,
    });
    const page = await (await h.req(`/library/file?key=${encodeURIComponent(KEY)}`)).text();
    for (const s of [STOCK.title, STOCK.creator, STOCK.copyright, STOCK.origin, STOCK.masterName])
      expect(page).toContain(s);
    expect(page).toContain('<td>Master</td>');
    const last = (await recentActions(h.db, 1))[0];
    expect(last?.action).toBe('library.uploaded');
    const detail = (last?.detail ?? {}) as { described?: string[] };
    expect((detail.described ?? []).sort()).toEqual(Object.keys(STOCK).sort());
  });

  it('never writes over what staff typed, on a retry, a second upload or a Replace', async () => {
    const h = harness();
    await h.put(KEY, bytes('stock'), { 'x-describe': header(STOCK) });
    // Staff correct the creator and clear the title; a retry of the same bytes with a
    // different entry changes nothing they touched, and fills nothing they emptied
    // because the row already exists with their values.
    await h.form('/library/file/save', [
      ['key', KEY],
      ['subject', 'campaigns/billing'],
      ['tags', 'man, finance'],
      ['alt_default', STOCK.description],
      ['credit', STOCK.credit],
      ['title', ''],
      ['creator', 'R. Teyparsit'],
      ['copyright', STOCK.copyright],
      ['origin', STOCK.origin],
    ]);
    const again = await h.put(KEY, bytes('stock'), {
      'x-describe': header({ ...STOCK, creator: 'Someone Else', title: 'New title' }),
    });
    expect(((await again.json()) as { completed?: boolean }).completed).toBe(true);
    const after = await getAsset(h.db, KEY);
    expect(after).toMatchObject({ creator: 'R. Teyparsit', tags: ['finance', 'man'] });
    // A cleared title is null in the row, so the retry's title is taken: an empty
    // field is an empty field. That is the rule, stated so it is not a surprise.
    expect(after?.title).toBe('New title');

    // Replace keeps every describe field, as it keeps the filing.
    const replaced = await h.replace(KEY, jpeg('v2'));
    expect(replaced.status).toBe(200);
    expect(await getAsset(h.db, KEY)).toMatchObject({
      creator: 'R. Teyparsit',
      copyright: STOCK.copyright,
      origin: STOCK.origin,
      master_name: STOCK.masterName,
    });
  });

  it('is found by its title and its creator, ranked with the subject and tags', async () => {
    const h = harness();
    await h.put(KEY, bytes('stock'), { 'x-describe': header(STOCK) });
    await h.put('media/campaigns/billing/other.jpg', bytes('other'), {
      'x-describe': header({ description: 'A man reading a letter about his bill' }),
    });
    const found = async (q: string) =>
      (await searchAssets(h.db, { ...ALL, q }, 10)).assets.map((a) => a.key);
    expect(await found('teyparsit')).toEqual([KEY]);
    expect(await found('shocked surprised')).toEqual([KEY]);
    expect((await found('bill')).sort()).toEqual([KEY, 'media/campaigns/billing/other.jpg']);
  });

  it('lists the files with no master, and leaves the filter out once one is linked', async () => {
    const h = harness();
    await h.put(KEY, bytes('stock'), { 'x-describe': header(STOCK) });
    await h.put('media/campaigns/billing/other.jpg', bytes('other'));
    const noMaster = async () =>
      (await searchAssets(h.db, { ...ALL, state: 'no-master' }, 10)).assets.map((a) => a.key);
    expect((await noMaster()).sort()).toEqual([KEY, 'media/campaigns/billing/other.jpg']);
    await fileAssets(
      h.db,
      h.deps.layout,
      [KEY],
      { masterUrl: 's3://shoots/2026/AdobeStock_270140535.ai' },
      STAFF.email,
      NOW,
    );
    expect(await noMaster()).toEqual(['media/campaigns/billing/other.jpg']);
    const page = await (await h.req('/library/search?state=no-master')).text();
    expect(page).toContain('other.jpg');
    expect(page).not.toContain('adobestock-270140535.jpg');
  });
});

describe('the master link', () => {
  it('accepts any URL with a scheme and nothing else', () => {
    for (const ok of [
      'https://drive.google.com/file/d/abc/view',
      's3://bucket/shoots/a.ai',
      'azure://container/a.psd',
      'smb://nas/shoots/a.tif',
    ])
      expect(isMasterUrl(ok)).toBe(true);
    expect(isMasterUrl('https://acme.sharepoint.com/sites/M/Shared Documents/a.ai')).toBe(true);
    for (const bad of [
      '',
      'not a url',
      'shoots/a.ai',
      'https://',
      'http://x y',
      'a:',
      'https://x/\u0007',
    ])
      expect(isMasterUrl(bad)).toBe(false);
  });

  it('names the provider from the host or scheme, with a lettered code', () => {
    expect(masterProvider('https://drive.google.com/file/d/abc/view')).toEqual({
      code: 'GD',
      label: 'Google Drive',
      icon: 'google-drive.svg',
    });
    expect(masterProvider('https://acme.sharepoint.com/sites/Marketing/x.ai').code).toBe('SP');
    expect(masterProvider('https://1drv.ms/u/s!abc').code).toBe('OD');
    expect(masterProvider('s3://bucket/a.ai')).toEqual({
      code: 'S3',
      label: 'Amazon S3',
      icon: 'amazon-s3.svg',
    });
    expect(masterProvider('https://bucket.s3.eu-west-1.amazonaws.com/a.ai').code).toBe('S3');
    expect(masterProvider('https://acme.blob.core.windows.net/masters/a.psd').code).toBe('AZ');
    expect(masterProvider('https://www.dropbox.com/s/abc/a.ai').code).toBe('DB');
    expect(masterProvider('https://www.box.com/s/abc')).toEqual({
      code: 'BX',
      label: 'Box',
      icon: 'box-white.svg',
      wide: true,
    });
    expect(masterProvider('smb://nas/shoots/a.tif')).toEqual({
      code: 'NAS',
      label: 'Network share',
      icon: null,
    });
    expect(masterProvider('https://files.example.com/a.ai')).toEqual({
      code: 'URL',
      label: 'files.example.com',
      icon: null,
    });
    expect(masterUrlIn('https://acme.sharepoint.com/sites/M/Shared Documents/', 'A b.ai')).toBe(
      'https://acme.sharepoint.com/sites/M/Shared Documents/A%20b.ai',
    );
  });

  it('is saved from the file page with its name, refused when malformed, and shown with its glyph', async () => {
    const h = harness();
    await h.put(KEY, bytes('stock'));
    const bad = await h.form('/library/file/save', [
      ['key', KEY],
      ['master_url', 'shoots/a.ai'],
    ]);
    const flash = decodeURIComponent(bad.headers.get('set-cookie')?.split(';')[0] ?? '');
    expect(atob(flash.replace(/^pr_flash=/, ''))).toContain('Master URL must be a link');
    expect((await getAsset(h.db, KEY))?.master_url).toBeNull();
    const ok = await h.form('/library/file/save', [
      ['key', KEY],
      ['subject', 'campaigns/billing'],
      ['master_url', 'https://drive.google.com/file/d/abc/view'],
      ['master_name', 'AdobeStock_270140535.ai'],
      ['creator', 'Rachata Teyparsit'],
      ['copyright', '© 2019 Sevendeman'],
      ['origin', 'Adobe Stock 270140535'],
      ['title', 'Shocked man'],
    ]);
    expect(ok.status).toBe(303);
    expect(await getAsset(h.db, KEY)).toMatchObject({
      master_url: 'https://drive.google.com/file/d/abc/view',
      master_name: 'AdobeStock_270140535.ai',
      creator: 'Rachata Teyparsit',
      title: 'Shocked man',
    });
    const audit = (await recentActions(h.db, 1))[0]?.detail as {
      changed: Record<string, unknown>;
    };
    expect(Object.keys(audit.changed).sort()).toEqual(
      ['copyright', 'creator', 'master_name', 'master_url', 'origin', 'title'].sort(),
    );
    const page = await (await h.req(`/library/file?key=${encodeURIComponent(KEY)}`)).text();
    expect(page).toContain('/static/vendor/brands/google-drive.svg');
    expect(page).toContain('Google Drive');
    expect(page).toContain('rel="noopener noreferrer"');
  });

  it('bulk filing sets the creator, and a master folder only where a name is recorded', async () => {
    const h = harness();
    await h.put(KEY, bytes('stock'), { 'x-describe': header(STOCK) });
    await h.put('media/campaigns/billing/other.jpg', bytes('other'));
    const fields: [string, string][] = [
      ['keys', KEY],
      ['keys', 'media/campaigns/billing/other.jpg'],
      ['creator', 'Studio'],
      ['master_base', 'https://acme.sharepoint.com/sites/M/Shared Documents/shoots/'],
      ['back', '/library'],
    ];
    const preview = await (await h.form('/library/bulk', fields)).text();
    expect(preview).toContain('Master folder');
    expect(preview).toContain('whose master name is recorded');
    await h.form('/library/bulk/apply', fields);
    expect(await getAsset(h.db, KEY)).toMatchObject({
      creator: 'Studio',
      master_url:
        'https://acme.sharepoint.com/sites/M/Shared Documents/shoots/AdobeStock_270140535.ai',
    });
    expect(await getAsset(h.db, 'media/campaigns/billing/other.jpg')).toMatchObject({
      creator: 'Studio',
      master_url: null,
    });
    const tiles = await (await h.req('/library?prefix=media/campaigns/billing/')).text();
    expect(tiles).toContain('by Studio');
  });

  it('recordReplace keeps the master and describe fields', async () => {
    const h = harness();
    await h.put(KEY, bytes('stock'), { 'x-describe': header(STOCK) });
    await recordReplace(
      h.db,
      h.deps.layout,
      {
        key: KEY,
        sha256: 'a'.repeat(64),
        etag: 'e',
        bytes: 1,
        content_type: 'image/jpeg',
        width: null,
        height: null,
        uploaded_by: STAFF.email,
      },
      NOW,
    );
    expect(await getAsset(h.db, KEY)).toMatchObject({ title: STOCK.title, origin: STOCK.origin });
  });
});
