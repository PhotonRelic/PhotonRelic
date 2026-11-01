import { imgMarkup, pictureMarkup } from '@photonrelic/media-params';
import { describe, expect, it } from 'vitest';
// The browser module's builder: a plain-JS copy of media-params', held to the same output here.
import { embedMarkup } from '../public/static/pr-markup.js';

const O = 'https://img.example.com';
const K = 'media/products/a&b/chair one.jpg';

describe('the markup panel rebuilds exactly what the server first rendered', () => {
  const cases: {
    name: string;
    widths: number[];
    ar?: string;
    sizes?: string;
    alt: string;
    width?: number;
    height?: number;
  }[] = [
    { name: 'defaults', widths: [1440, 480, 768, 1024], alt: 'A chair' },
    { name: 'a crop', widths: [320, 320, 768], ar: '16:9', sizes: '50vw', alt: '' },
    {
      name: 'a known source size',
      widths: [480, 2048],
      sizes: '(min-width: 60em) 50vw, 100vw',
      alt: 'Say "hi" <b>& go</b>',
      width: 800,
      height: 600,
    },
  ];
  for (const c of cases) {
    it(`for ${c.name}, picture and img`, () => {
      const o = {
        widths: c.widths,
        alt: c.alt,
        ...(c.ar ? { ar: c.ar } : {}),
        ...(c.sizes ? { sizes: c.sizes } : {}),
        ...(c.width && c.height ? { width: c.width, height: c.height } : {}),
      };
      expect(embedMarkup(O, K, { kind: 'picture', ...o })).toBe(pictureMarkup(O, K, o));
      expect(embedMarkup(O, K, { kind: 'img', ...o })).toBe(imgMarkup(O, K, o));
    });
  }

  it('asks for a width when none is ticked', () => {
    expect(() => embedMarkup(O, K, { kind: 'picture', widths: [], alt: '' })).toThrow(/width/);
  });
});
