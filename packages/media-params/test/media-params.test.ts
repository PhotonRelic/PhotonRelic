import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MENU,
  mediaUrl,
  menuFromLists,
  negotiateFormat,
  parseMediaParams,
  USAGE_INDEX_MAX_BYTES,
  usageIndex,
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
      params: { width: 320, height: 240, fit: 'cover', format: 'jpeg', resolved: 'jpeg' },
    });
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
