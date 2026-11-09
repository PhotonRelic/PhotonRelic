import { describe, expect, it } from 'vitest';
import {
  assetListUrl,
  assetUrl,
  DEFAULT_MENU,
  imgMarkup,
  mediaUrl,
  menuFromLists,
  negotiateFormat,
  parseMediaParams,
  pictureMarkup,
  srcset,
  transformUrl,
  USAGE_INDEX_MAX_BYTES,
  usageIndex,
  variantUrls,
} from '../src/index.js';

const u = (q: string) => new URL(`https://img.example.com/media/a/b.jpg${q}`);

describe('parseMediaParams', () => {
  it('serves as stored without parameters', () => {
    expect(parseMediaParams(u(''), null)).toEqual({ kind: 'none' });
  });

  it('scales down to a menu width and negotiates the format on Accept', () => {
    const r = parseMediaParams(u('?w=768'), 'image/avif,image/webp,*/*');
    expect(r).toEqual({
      kind: 'transform',
      params: { width: 768, fit: 'scale-down', format: 'auto', resolved: 'avif' },
    });
  });

  it('crops to cover with an aspect ratio', () => {
    const r = parseMediaParams(u('?w=320&ar=4:3&f=jpeg'), null);
    expect(r).toEqual({
      kind: 'transform',
      params: {
        width: 320,
        height: 240,
        aspect: '4:3',
        fit: 'cover',
        format: 'jpeg',
        resolved: 'jpeg',
      },
    });
  });

  it('accepts one spelling of each parameter and nothing else', () => {
    for (const q of ['?w=0320', '?w=00320', '?w=3.2e2', '?w=320.0', '?w=%2B320', '?w=%20320']) {
      expect(parseMediaParams(u(q), null).kind, q).toBe('error');
    }
    for (const q of ['?w=320&w=480', '?w=320&w=320', '?w=320&f=webp&f=webp']) {
      expect(parseMediaParams(u(q), null)).toEqual({
        kind: 'error',
        message: expect.stringMatching(/more than once/),
      });
    }
    expect(parseMediaParams(u('?'), null)).toEqual({ kind: 'none' });
    expect(parseMediaParams(u('?w=320'), null).kind).toBe('transform');
  });

  it('builds the one cache URL for a transform, the way variantUrls spells it', () => {
    const origin = 'https://img.example.com';
    const key = 'media/workshop/bench.jpg';
    const parsed = parseMediaParams(u('?f=auto&ar=16:9&w=320'), 'image/avif');
    expect(parsed.kind).toBe('transform');
    if (parsed.kind !== 'transform') return;
    const url = transformUrl(origin, key, parsed.params);
    expect(url).toBe(`${origin}/media/workshop/bench.jpg?ar=16%3A9&f=avif&w=320`);
    expect(variantUrls(origin, key)).toContain(url);
    const plain = parseMediaParams(u('?w=768'), null);
    if (plain.kind !== 'transform') throw new Error('expected a transform');
    expect(transformUrl(origin, key, plain.params)).toBe(
      `${origin}/media/workshop/bench.jpg?f=jpeg&w=768`,
    );
  });

  it('refuses anything off the menu', () => {
    expect(parseMediaParams(u('?w=777'), null).kind).toBe('error');
    expect(parseMediaParams(u('?w=320&ar=7:3'), null).kind).toBe('error');
    expect(parseMediaParams(u('?w=320&f=gif'), null).kind).toBe('error');
    expect(parseMediaParams(u('?f=webp'), null).kind).toBe('error');
    expect(parseMediaParams(u('?ar=1:1'), null).kind).toBe('error');
    expect(parseMediaParams(u('?w=320&q=80'), null)).toEqual({
      kind: 'error',
      message: 'Unknown parameter: q',
    });
  });

  it('takes a custom menu', () => {
    const menu = menuFromLists('100, 50', '2:1');
    expect(menu.widths).toEqual([50, 100]);
    expect(parseMediaParams(u('?w=100&ar=2:1'), null, menu).kind).toBe('transform');
    expect(parseMediaParams(u('?w=320'), null, menu).kind).toBe('error');
  });
});

describe('menuFromLists', () => {
  it('keeps the defaults when unset and throws on a malformed entry', () => {
    expect(menuFromLists()).toEqual(DEFAULT_MENU);
    expect(menuFromLists('', ' ')).toEqual(DEFAULT_MENU);
    expect(() => menuFromLists('wide')).toThrow(/width/);
    expect(() => menuFromLists('99999')).toThrow(/width/);
    expect(() => menuFromLists(undefined, '16x9')).toThrow(/aspect/);
  });
});

describe('negotiateFormat', () => {
  it('prefers avif, then webp, then jpeg', () => {
    expect(negotiateFormat('image/avif')).toBe('avif');
    expect(negotiateFormat('image/webp')).toBe('webp');
    expect(negotiateFormat('*/*')).toBe('jpeg');
    expect(negotiateFormat(null)).toBe('jpeg');
  });
});

describe('mediaUrl', () => {
  it('serves a key at its own path, resized when asked', () => {
    expect(mediaUrl('https://img.example.com/', 'media/a b/c.jpg')).toBe(
      'https://img.example.com/media/a%20b/c.jpg',
    );
    expect(mediaUrl('https://img.example.com', 'media/c.jpg', { w: 320 })).toBe(
      'https://img.example.com/media/c.jpg?w=320&f=auto',
    );
    expect(
      mediaUrl('https://img.example.com', 'media/c.jpg', { w: 320, ar: '1:1', f: 'webp' }),
    ).toBe('https://img.example.com/media/c.jpg?w=320&ar=1%3A1&f=webp');
  });
});

describe('usageIndex', () => {
  it('is the key itself when it fits, a marked stable hash otherwise', () => {
    expect(usageIndex('media/products/chair.jpg')).toBe('media/products/chair.jpg');
    const fits = `media/${'a'.repeat(USAGE_INDEX_MAX_BYTES - 10)}.jpg`;
    expect(usageIndex(fits)).toBe(fits);
    const long = `media/${'a'.repeat(200)}.jpg`;
    expect(usageIndex(long)).toMatch(/^#[0-9a-f]{16}$/);
    expect(usageIndex(long)).toBe(usageIndex(long));
    expect(usageIndex(long)).not.toBe(usageIndex(`${long.slice(0, -4)}-2.jpg`));
    // Bytes, not characters: a multi-byte name over the cap is hashed too.
    expect(usageIndex(`media/${'é'.repeat(60)}.jpg`)).toMatch(/^#/);
  });
});

describe('assetUrl and assetListUrl', () => {
  it('builds the metadata URL for a key, encoded per segment like mediaUrl', () => {
    expect(assetUrl('https://img.example.com/', 'media/a b/c.jpg')).toBe(
      'https://img.example.com/api/v1/assets/media/a%20b/c.jpg',
    );
    expect(assetUrl('https://img.example.com', 'media/café.jpg')).toBe(
      'https://img.example.com/api/v1/assets/media/caf%C3%A9.jpg',
    );
  });

  it('builds the listing URL with only the filters given', () => {
    expect(assetListUrl('https://img.example.com/')).toBe('https://img.example.com/api/v1/assets');
    expect(
      assetListUrl('https://img.example.com', {
        prefix: 'media/products/',
        subject: 'products',
        tag: 'hero shot',
        limit: 50,
        cursor: 'bWVkaWEvYS5qcGc',
      }),
    ).toBe(
      'https://img.example.com/api/v1/assets?prefix=media%2Fproducts%2F&subject=products&tag=hero+shot&limit=50&cursor=bWVkaWEvYS5qcGc',
    );
  });
});

describe('embed markup', () => {
  const O = 'https://img.example.com';
  const K = 'media/products/chair.jpg';

  it('builds a srcset from menu widths, ascending and deduplicated', () => {
    expect(srcset(O, K, [768, 320, 320])).toBe(
      `${O}/${K}?w=320&f=auto 320w, ${O}/${K}?w=768&f=auto 768w`,
    );
    expect(srcset(O, K, [320], { ar: '1:1', f: 'webp' })).toBe(
      `${O}/${K}?w=320&ar=1%3A1&f=webp 320w`,
    );
  });

  it('refuses an off-menu width or aspect, and no widths at all', () => {
    expect(() => srcset(O, K, [777])).toThrow(/w must be one of/);
    expect(() => srcset(O, K, [320], { ar: '7:3' })).toThrow(/ar must be one of/);
    expect(() => srcset(O, K, [])).toThrow(/at least one/);
    expect(() => pictureMarkup(O, K, { widths: [320], alt: '' }, menuFromLists('100'))).toThrow(
      /w must be one of 100/,
    );
    expect(() =>
      imgMarkup(O, K, { widths: [320], ar: '1:1', alt: '' }, menuFromLists('320', '2:1')),
    ).toThrow(/ar must be one of 2:1/);
  });

  it('writes a picture with avif and webp sources and a jpeg fallback at the largest width', () => {
    const html = pictureMarkup(O, K, {
      widths: [1024, 480],
      sizes: '(min-width: 60em) 50vw, 100vw',
      alt: 'A chair',
      width: 2000,
      height: 1500,
    });
    const sizes = 'sizes="(min-width: 60em) 50vw, 100vw"';
    expect(html).toBe(
      [
        '<picture>',
        `  <source type="image/avif" srcset="${O}/${K}?w=480&amp;f=avif 480w, ${O}/${K}?w=1024&amp;f=avif 1024w" ${sizes}>`,
        `  <source type="image/webp" srcset="${O}/${K}?w=480&amp;f=webp 480w, ${O}/${K}?w=1024&amp;f=webp 1024w" ${sizes}>`,
        `  <img src="${O}/${K}?w=1024&amp;f=jpeg" srcset="${O}/${K}?w=480&amp;f=jpeg 480w, ${O}/${K}?w=1024&amp;f=jpeg 1024w" ${sizes} alt="A chair" width="1024" height="768" loading="lazy" decoding="async">`,
        '</picture>',
      ].join('\n'),
    );
  });

  it('writes a plain img with f=auto, 100vw by default, and no size without the source size', () => {
    expect(
      imgMarkup(O, K, { widths: [320], alt: 'A chair', loading: 'eager', decoding: 'sync' }),
    ).toBe(
      `<img src="${O}/${K}?w=320&amp;f=auto" srcset="${O}/${K}?w=320&amp;f=auto 320w" sizes="100vw" alt="A chair" loading="eager" decoding="sync">`,
    );
  });

  it('sizes a cover crop from the ratio and a scale-down from the source, never enlarging', () => {
    const crop = imgMarkup(O, K, { widths: [320, 768], ar: '16:9', alt: '' });
    expect(crop).toContain(`src="${O}/${K}?w=768&amp;ar=16%3A9&amp;f=auto"`);
    expect(crop).toContain(' width="768" height="432" ');
    const small = imgMarkup(O, K, { widths: [1440], alt: '', width: 800, height: 600 });
    expect(small).toContain(' width="800" height="600" ');
    const large = imgMarkup(O, K, { widths: [480], alt: '', width: 2000, height: 1500 });
    expect(large).toContain(' width="480" height="360" ');
  });

  it('escapes quotes, angle brackets and ampersands in attributes', () => {
    const html = imgMarkup(O, 'media/a&b/c.jpg', {
      widths: [320],
      alt: 'Say "hi" <b>& go</b>',
    });
    expect(html).toContain('alt="Say &quot;hi&quot; &lt;b&gt;&amp; go&lt;/b&gt;"');
    expect(html).toContain('/media/a%26b/c.jpg?w=320&amp;f=auto');
    expect(html).not.toContain('<b>');
  });
});

describe('variantUrls', () => {
  it('lists the stored URL and every width, crop and format, query sorted by key', () => {
    const urls = variantUrls(
      'https://img.example.com/',
      'media/a b/c.jpg',
      menuFromLists('320,768', '1:1'),
    );
    // 1 stored + 2 widths × (none + 1 aspect) × 3 formats.
    expect(urls).toHaveLength(1 + 2 * 2 * 3);
    expect(urls[0]).toBe('https://img.example.com/media/a%20b/c.jpg');
    expect(urls).toContain('https://img.example.com/media/a%20b/c.jpg?f=avif&w=320');
    expect(urls).toContain('https://img.example.com/media/a%20b/c.jpg?ar=1%3A1&f=jpeg&w=768');
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.some((u) => u.includes('f=auto'))).toBe(false);
  });

  it('covers the default menu', () => {
    expect(variantUrls('https://img.example.com', 'media/c.jpg')).toHaveLength(
      1 + DEFAULT_MENU.widths.length * (1 + DEFAULT_MENU.aspects.length) * 3,
    );
  });
});
