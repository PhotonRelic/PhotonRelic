import { describe, expect, it } from 'vitest';
import {
  FACET_TAGS,
  fileAssets,
  forgetAsset,
  ftsQuery,
  noteSeen,
  recordUpload,
  retireAsset,
  type SearchFilters,
  searchAssets,
  searchFacets,
  type UploadRecord,
} from '../src/library.js';
import { bytes, harness } from './helpers.js';

const NOW = new Date('2026-10-30T12:00:00.000Z');
const ALL: SearchFilters = { q: '', subject: null, tag: null, camera: null, state: 'all' };

type H = ReturnType<typeof harness>;

/** Keys found, in the order the search returns them. */
async function keys(h: H, q: string, extra: Partial<SearchFilters> = {}): Promise<string[]> {
  const r = await searchAssets(h.db, { ...ALL, q, ...extra }, 50);
  return r.assets.map((a) => a.key);
}

/** A small library filed through the store's own writes, so every row went through the triggers. */
async function seed(h: H): Promise<void> {
  const { layout } = h.deps;
  await fileAssets(
    h.db,
    layout,
    ['media/products/chairs/oak.jpg'],
    {
      subject: 'products/chairs',
      addTags: ['hero-shot', 'wood'],
      credit: 'Studio North',
      altPattern: 'An oak chair in the showroom',
    },
    'a@example.com',
    new Date('2026-10-01T00:00:00.000Z'),
  );
  await fileAssets(
    h.db,
    layout,
    ['media/products/lamps/brass.jpg'],
    { subject: 'products/lamps', addTags: ['detail', 'brass'], altPattern: 'A brass lamp' },
    'a@example.com',
    new Date('2026-10-02T00:00:00.000Z'),
  );
  await fileAssets(
    h.db,
    layout,
    ['media/people/team.jpg'],
    { subject: 'people', addTags: ['wood', 'hero-shot'], credit: 'Studio South' },
    'a@example.com',
    new Date('2026-10-03T00:00:00.000Z'),
  );
  // Seen in the bucket, never filed.
  await noteSeen(
    h.db,
    layout,
    [{ key: 'legacy/scan-woodland.jpg', size: 10, uploaded: null, etag: 'e1' }],
    new Date('2026-10-04T00:00:00.000Z'),
  );
  // Filed, then retired.
  await fileAssets(
    h.db,
    layout,
    ['media/products/chairs/oak-old.jpg'],
    { subject: 'products/chairs', addTags: ['wood'], altPattern: 'An oak chair, reshot' },
    'a@example.com',
    new Date('2026-10-05T00:00:00.000Z'),
  );
  await retireAsset(h.db, 'media/products/chairs/oak-old.jpg', 'reshot', true, NOW);
}

describe('search index', () => {
  it('indexes a row as it is filed, re-indexes it on update and forgets it on delete', async () => {
    const h = harness();
    const key = 'media/products/chairs/oak.jpg';
    await fileAssets(
      h.db,
      h.deps.layout,
      [key],
      { subject: 'products/chairs', addTags: ['wood'], altPattern: 'An oak chair' },
      'a@example.com',
      NOW,
    );
    expect(await keys(h, 'wood')).toEqual([key]);
    expect(await keys(h, 'showroom')).toEqual([]);

    // The filing upsert takes the ON CONFLICT path, which fires the update trigger.
    await fileAssets(
      h.db,
      h.deps.layout,
      [key],
      { addTags: ['walnut'], removeTags: ['wood'], altPattern: 'A walnut chair in the showroom' },
      'a@example.com',
      NOW,
    );
    expect(await keys(h, 'walnut')).toEqual([key]);
    expect(await keys(h, 'showroom')).toEqual([key]);
    expect(await keys(h, 'wood')).toEqual([]);

    await forgetAsset(h.db, key);
    expect(await keys(h, 'walnut')).toEqual([]);
    expect(await keys(h, 'chair')).toEqual([]);
  });

  it('indexes keys a Rescan notes, and the subject a later filing gives them', async () => {
    const h = harness();
    await noteSeen(
      h.db,
      h.deps.layout,
      [{ key: 'legacy/riverside-mill.jpg', size: 1, uploaded: null, etag: 'e' }],
      NOW,
    );
    expect(await keys(h, 'riverside')).toEqual(['legacy/riverside-mill.jpg']);
    expect(await keys(h, 'landmarks')).toEqual([]);
    await fileAssets(
      h.db,
      h.deps.layout,
      ['legacy/riverside-mill.jpg'],
      { subject: 'landmarks' },
      'a@example.com',
      NOW,
    );
    expect(await keys(h, 'landmarks')).toEqual(['legacy/riverside-mill.jpg']);
  });

  it('is rebuilt by a Rescan', async () => {
    const h = harness();
    await h.media.put('media/x/harbour.jpg', bytes('h'), 'image/jpeg');
    await h.form('/library/rescan', []);
    expect(await keys(h, 'harbour')).toEqual(['media/x/harbour.jpg']);
    // An index that somehow lost its entries comes back on the next walk of the bucket.
    await h.db.prepare("INSERT INTO assets_fts (assets_fts) VALUES ('delete-all')").run();
    expect(await keys(h, 'harbour')).toEqual([]);
    await h.form('/library/rescan', []);
    expect(await keys(h, 'harbour')).toEqual(['media/x/harbour.jpg']);
  });
});

describe('query text', () => {
  it('quotes every word and prefixes the last, so nothing typed is FTS5 syntax', () => {
    expect(ftsQuery('"foo" OR bar*')).toBe('"foo" "OR" "bar*"*');
    expect(ftsQuery('oak chair')).toBe('"oak" "chair"*');
    expect(ftsQuery('hero-shot')).toBe('"hero-shot"*');
    expect(ftsQuery('  NEAR(a b) key:x ^start NOT  ')).toBe(
      '"NEAR(a" "b)" "key:x" "^start" "NOT"*',
    );
    expect(ftsQuery('')).toBeNull();
    expect(ftsQuery('   ')).toBeNull();
    expect(ftsQuery('"" -- * ()')).toBeNull();
  });

  it('runs operator-like input as words without an error', async () => {
    const h = harness();
    await seed(h);
    for (const q of ['"foo" OR bar*', 'oak AND NOT lamp', 'NEAR(oak chair)', 'tags:wood', '"', '*'])
      await expect(searchAssets(h.db, { ...ALL, q }, 50)).resolves.toBeDefined();
    // "OR" is a word here, not an operator: both words must be present.
    expect(await keys(h, 'oak OR brass')).toEqual([]);
    expect(await keys(h, '"oak" chair')).toContain('media/products/chairs/oak.jpg');
  });

  it('finds a file by tag, a word of its alt text, its credit, its subject and its path', async () => {
    const h = harness();
    await seed(h);
    const oak = 'media/products/chairs/oak.jpg';
    expect(await keys(h, 'hero-shot')).toEqual(
      expect.arrayContaining([oak, 'media/people/team.jpg']),
    );
    expect(await keys(h, 'showroom')).toEqual([oak]);
    expect(await keys(h, 'north')).toEqual([oak]);
    expect(await keys(h, 'lamps')).toEqual(['media/products/lamps/brass.jpg']);
    expect(await keys(h, 'legacy')).toEqual(['legacy/scan-woodland.jpg']);
    expect(await keys(h, 'Oak Chair')).toContain(oak);
  });

  it('prefix-matches the last word only', async () => {
    const h = harness();
    await seed(h);
    expect(await keys(h, 'show')).toEqual(['media/products/chairs/oak.jpg']);
    expect(await keys(h, 'show chair')).toEqual([]);
  });

  it('ranks a match in the tags or subject above one in the path alone', async () => {
    const h = harness();
    await fileAssets(
      h.db,
      h.deps.layout,
      ['media/x/lamp.jpg'],
      { subject: 'x' },
      'a@example.com',
      new Date('2026-10-09T00:00:00.000Z'),
    );
    await fileAssets(
      h.db,
      h.deps.layout,
      ['media/x/b.jpg'],
      { subject: 'x', addTags: ['lamp'] },
      'a@example.com',
      new Date('2026-10-01T00:00:00.000Z'),
    );
    expect(await keys(h, 'lamp')).toEqual(['media/x/b.jpg', 'media/x/lamp.jpg']);
  });
});

describe('filters', () => {
  it('lists everything newest first with no query, and pages with a total', async () => {
    const h = harness();
    await seed(h);
    const all = await searchAssets(h.db, ALL, 50);
    expect(all.total).toBe(5);
    expect(all.assets.map((a) => a.key)).toEqual([
      'media/products/chairs/oak-old.jpg',
      'legacy/scan-woodland.jpg',
      'media/people/team.jpg',
      'media/products/lamps/brass.jpg',
      'media/products/chairs/oak.jpg',
    ]);
    const second = await searchAssets(h.db, ALL, 2, 2);
    expect(second.total).toBe(5);
    expect(second.assets.map((a) => a.key)).toEqual([
      'media/people/team.jpg',
      'media/products/lamps/brass.jpg',
    ]);
  });

  it('filters by exact subject', async () => {
    const h = harness();
    await seed(h);
    expect(await keys(h, '', { subject: 'products/chairs' })).toEqual([
      'media/products/chairs/oak-old.jpg',
      'media/products/chairs/oak.jpg',
    ]);
    expect(await keys(h, '', { subject: 'products' })).toEqual([]);
    expect(await keys(h, 'showroom', { subject: 'products/chairs' })).toEqual([
      'media/products/chairs/oak.jpg',
    ]);
    expect(await keys(h, 'showroom', { subject: 'people' })).toEqual([]);
  });

  it('filters by exact tag against the JSON array', async () => {
    const h = harness();
    await seed(h);
    expect(await keys(h, '', { tag: 'wood' })).toEqual([
      'media/products/chairs/oak-old.jpg',
      'media/people/team.jpg',
      'media/products/chairs/oak.jpg',
    ]);
    expect(await keys(h, '', { tag: 'woo' })).toEqual([]);
    expect(await keys(h, '', { tag: 'woodland' })).toEqual([]);
    expect(await keys(h, '', { tag: 'wood', subject: 'people' })).toEqual([
      'media/people/team.jpg',
    ]);
  });

  it('filters by state without a query', async () => {
    const h = harness();
    await seed(h);
    expect(await keys(h, '', { state: 'unfiled' })).toEqual(['legacy/scan-woodland.jpg']);
    expect(await keys(h, '', { state: 'retired' })).toEqual(['media/products/chairs/oak-old.jpg']);
    expect(await keys(h, '', { state: 'filed' })).toEqual([
      'media/people/team.jpg',
      'media/products/lamps/brass.jpg',
      'media/products/chairs/oak.jpg',
    ]);
    expect((await searchAssets(h.db, { ...ALL, state: 'all' }, 50)).total).toBe(5);
    // With a query too.
    expect(await keys(h, 'oak', { state: 'retired' })).toEqual([
      'media/products/chairs/oak-old.jpg',
    ]);
    expect(await keys(h, 'oak', { state: 'filed' })).toEqual(['media/products/chairs/oak.jpg']);
  });
});

describe('facets', () => {
  it('counts subjects and tags over the matches', async () => {
    const h = harness();
    await seed(h);
    const f = await searchFacets(h.db, ALL);
    expect(f.subjects).toEqual([
      { value: 'products/chairs', n: 2 },
      { value: 'people', n: 1 },
      { value: 'products/lamps', n: 1 },
    ]);
    expect(f.tags).toEqual([
      { value: 'wood', n: 3 },
      { value: 'hero-shot', n: 2 },
      { value: 'brass', n: 1 },
      { value: 'detail', n: 1 },
    ]);
    const live = await searchFacets(h.db, { ...ALL, q: 'oak', state: 'filed' });
    expect(live.subjects).toEqual([{ value: 'products/chairs', n: 1 }]);
    expect(live.tags).toEqual([
      { value: 'hero-shot', n: 1 },
      { value: 'wood', n: 1 },
    ]);
  });

  it('leaves a facet’s own filter out, so the other values stay on offer', async () => {
    const h = harness();
    await seed(h);
    const f = await searchFacets(h.db, { ...ALL, subject: 'people', tag: 'wood' });
    // Subjects: among wood-tagged files, whatever their subject.
    expect(f.subjects).toEqual([
      { value: 'products/chairs', n: 2 },
      { value: 'people', n: 1 },
    ]);
    // Tags: among files under people, whatever their tags.
    expect(f.tags).toEqual([
      { value: 'hero-shot', n: 1 },
      { value: 'wood', n: 1 },
    ]);
  });

  it('caps the tag list at the most used', async () => {
    const h = harness();
    const tags = Array.from({ length: FACET_TAGS + 5 }, (_, i) => `t${String(i).padStart(2, '0')}`);
    await fileAssets(
      h.db,
      h.deps.layout,
      ['media/x/a.jpg'],
      { subject: 'x', addTags: tags },
      'a@example.com',
      NOW,
    );
    await fileAssets(
      h.db,
      h.deps.layout,
      ['media/x/b.jpg'],
      { subject: 'x', addTags: ['t34'] },
      'a@example.com',
      NOW,
    );
    const f = await searchFacets(h.db, ALL);
    expect(f.tags).toHaveLength(FACET_TAGS);
    expect(f.tags[0]).toEqual({ value: 't34', n: 2 });
  });
});

describe('capture data', () => {
  /** Two shoots and a stock file, uploaded with what the browser knew about each original. */
  async function shoot(h: H): Promise<void> {
    const up = async (key: string, capture: UploadRecord['capture'], when: string) =>
      recordUpload(
        h.db,
        h.deps.layout,
        {
          key,
          sha256: 'a'.repeat(63) + key.length.toString(16),
          etag: null,
          bytes: 100,
          content_type: 'image/jpeg',
          width: 800,
          height: 600,
          uploaded_by: 'a@example.com',
          capture,
        },
        new Date(when),
      );
    await up(
      'media/events/launch/stage.jpg',
      { capturedAt: '2026-05-30T14:55:50', camera: 'NIKON Z 7', lens: 'NIKKOR Z 85mm f/1.8 S' },
      '2026-10-01T00:00:00.000Z',
    );
    await up(
      'media/events/launch/crowd.jpg',
      { capturedAt: '2026-05-30T15:02:11', camera: 'NIKON Z 7' },
      '2026-10-02T00:00:00.000Z',
    );
    await up(
      'media/events/launch/signing.jpg',
      { camera: 'Canon EOS R5', lens: 'RF35mm F1.8' },
      '2026-10-03T00:00:00.000Z',
    );
    await up('media/events/launch/stock.jpg', null, '2026-10-04T00:00:00.000Z');
  }

  it('finds a file by its camera or lens', async () => {
    const h = harness();
    await shoot(h);
    expect(await keys(h, 'nikon')).toEqual([
      'media/events/launch/crowd.jpg',
      'media/events/launch/stage.jpg',
    ]);
    expect(await keys(h, 'nikkor 85mm')).toEqual(['media/events/launch/stage.jpg']);
    expect(await keys(h, 'canon')).toEqual(['media/events/launch/signing.jpg']);
    expect(await keys(h, 'rf35')).toEqual(['media/events/launch/signing.jpg']);
  });

  it('indexes the camera an upload completes on a row a Rescan noted first', async () => {
    const h = harness();
    await noteSeen(
      h.db,
      h.deps.layout,
      [{ key: 'media/events/launch/stage.jpg', size: 10, uploaded: null, etag: 'e1' }],
      NOW,
    );
    expect(await keys(h, 'nikon')).toEqual([]);
    await shoot(h);
    expect(await keys(h, 'nikon')).toContain('media/events/launch/stage.jpg');
  });

  it('offers the cameras among the matches as a facet and filters by one exactly', async () => {
    const h = harness();
    await shoot(h);
    expect((await searchFacets(h.db, ALL)).cameras).toEqual([
      { value: 'NIKON Z 7', n: 2 },
      { value: 'Canon EOS R5', n: 1 },
    ]);
    expect(await keys(h, '', { camera: 'NIKON Z 7' })).toEqual([
      'media/events/launch/crowd.jpg',
      'media/events/launch/stage.jpg',
    ]);
    expect(await keys(h, '', { camera: 'nikon z 7' })).toEqual([]);
    // The camera facet leaves its own filter out; the others keep it.
    const f = await searchFacets(h.db, { ...ALL, camera: 'Canon EOS R5' });
    expect(f.cameras).toEqual([
      { value: 'NIKON Z 7', n: 2 },
      { value: 'Canon EOS R5', n: 1 },
    ]);
    expect(f.subjects).toEqual([{ value: 'events/launch', n: 1 }]);
  });

  it('shows the camera facet on the page and keeps it in the links', async () => {
    const h = harness();
    await shoot(h);
    const html = await (await h.req('/library/search?q=launch')).text();
    expect(html).toContain('Camera');
    expect(html).toContain('camera=NIKON+Z+7');
    const narrowed = await (await h.req('/library/search?camera=Canon+EOS+R5')).text();
    expect(narrowed).toContain('class="facet active"');
    expect(narrowed).toContain('signing.jpg');
    expect(narrowed).not.toContain('crowd.jpg');
  });
});

describe('search page', () => {
  it('renders the matches as selectable tiles with facets, a count and the filters as links', async () => {
    const h = harness();
    await seed(h);
    const res = await h.req('/library/search?q=oak');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('oak.jpg');
    expect(html).toContain('oak-old.jpg');
    expect(html).not.toContain('brass.jpg');
    expect(html).toContain('2</span> files match');
    expect(html).toContain('name="keys" value="media/products/chairs/oak.jpg"');
    expect(html).toContain('name="back" value="/library/search?q=oak"');
    expect(html).toContain('href="/library/search?q=oak&amp;tag=wood"');
    expect(html).toContain('href="/library/search?q=oak&amp;subject=products%2Fchairs"');
    expect(html).toContain('href="/library/search?q=oak&amp;state=retired"');
    expect(html).toContain('after a Rescan');
  });

  it('filters without a query, marks the chosen value and clears it', async () => {
    const h = harness();
    await seed(h);
    const retired = await (await h.req('/library/search?state=retired')).text();
    expect(retired).toContain('oak-old.jpg');
    expect(retired).not.toContain('>oak.jpg<');
    expect(retired).toContain('1</span> file matches');
    expect(retired).toContain('href="/library/search"');

    const unfiled = await (await h.req('/library/search?state=unfiled')).text();
    expect(unfiled).toContain('scan-woodland.jpg');
    expect(unfiled).not.toContain('team.jpg');

    const tagged = await (await h.req('/library/search?tag=wood&subject=people')).text();
    expect(tagged).toContain('team.jpg');
    expect(tagged).not.toContain('oak.jpg');
    // The chosen tag links to its own removal and is lit.
    expect(tagged).toContain('class="facet active"');
    expect(tagged).toContain('href="/library/search?subject=people"');
  });

  it('treats operator-like input as words and ignores a bad state or page', async () => {
    const h = harness();
    await seed(h);
    expect((await h.req('/library/search?q=%22foo%22%20OR%20bar*')).status).toBe(200);
    expect((await h.req('/library/search?q=oak&state=bogus&page=-3')).status).toBe(200);
    const far = await (await h.req('/library/search?page=99')).text();
    expect(far).toContain('5</span> files known');
  });

  it('files a page of results in bulk and returns to the same search', async () => {
    const h = harness();
    await seed(h);
    const fields: [string, string][] = [
      ['keys', 'legacy/scan-woodland.jpg'],
      ['subject', 'scans'],
      ['back', '/library/search?state=unfiled'],
    ];
    const apply = await h.form('/library/bulk/apply', fields);
    expect(apply.headers.get('location')).toBe('/library/search?state=unfiled');
    expect(await keys(h, 'scans')).toEqual(['legacy/scan-woodland.jpg']);
    expect(await keys(h, '', { state: 'unfiled' })).toEqual([]);
  });

  it('has the search box in the header of every page', async () => {
    const h = harness();
    const html = await (await h.req('/library/upload')).text();
    expect(html).toContain('action="/library/search"');
  });
});
