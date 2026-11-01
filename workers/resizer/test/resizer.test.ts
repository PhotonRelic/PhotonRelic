import { DEFAULT_MENU, MAX_TRANSFORM_SOURCE_BYTES, menuFromLists } from '@photonrelic/media-params';
import { describe, expect, it } from 'vitest';
import { CACHE_STORED, CACHE_TRANSFORMED, createApp } from '../src/app.js';
import { type ImageTransformer, TransformFailed, type TransformOptions } from '../src/images.js';
import { isServableKey, MemoryMediaSource, parsePrefixes } from '../src/source.js';

/** The first bytes of a PNG, enough to be a distinct stored object. */
const png = () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).buffer as ArrayBuffer;

class FakeImages implements ImageTransformer {
  calls: TransformOptions[] = [];
  failures = 0;
  async transform(input: ReadableStream | ArrayBuffer, opts: TransformOptions) {
    if (input instanceof ReadableStream) await new Response(input).arrayBuffer();
    this.calls.push(opts);
    if (this.failures > 0) {
      this.failures -= 1;
      throw new TransformFailed('short body');
    }
    const body = new TextEncoder().encode(
      `resized:${opts.width}x${opts.height ?? 'auto'}:${opts.fit}`,
    ).buffer as ArrayBuffer;
    return { body, contentType: opts.format };
  }
}

function harness(opts: { images?: boolean; prefixes?: string[]; menu?: typeof DEFAULT_MENU } = {}) {
  const source = new MemoryMediaSource();
  source.put('media/workshop/bench.jpg', png(), 'image/jpeg');
  source.put('media/products/Chair-01ABC.PNG', png(), 'image/png');
  source.put('private/secret.jpg', png(), 'image/jpeg');
  source.put('media/vector/logo.svg', png(), 'image/svg+xml');
  const images = new FakeImages();
  const app = createApp({
    source,
    images: opts.images === false ? null : images,
    prefixes: opts.prefixes ?? ['media/'],
    menu: opts.menu ?? DEFAULT_MENU,
  });
  const get = (path: string, headers: Record<string, string> = {}) =>
    app.request(`https://img.example.com${path}`, { headers });
  return { source, images, get };
}

describe('served as stored', () => {
  it('serves objects under a served prefix and nothing else', async () => {
    const h = harness();
    const res = await h.get('/media/workshop/bench.jpg');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe(CACHE_STORED);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(png()));
    expect(h.images.calls).toHaveLength(0);

    expect((await h.get('/media/products/Chair-01ABC.PNG')).status).toBe(200);
    expect((await h.get('/private/secret.jpg')).status).toBe(404);
    expect((await h.get('/media/vector/logo.svg')).status).toBe(404);
    expect((await h.get('/media/missing.jpg')).status).toBe(404);
    expect((await h.get('/media/../private/secret.jpg')).status).toBe(404);
    expect((await h.get('/media/%2e%2e/private/secret.jpg')).status).toBe(404);
    expect((await h.get('/')).status).toBe(404);
  });

  it('serves a second prefix when configured', async () => {
    const h = harness({ prefixes: ['media/', 'private/'] });
    expect((await h.get('/private/secret.jpg')).status).toBe(200);
  });
});

describe('resized on request', () => {
  it('resizes to a menu width, scale-down by default, cover with an aspect ratio', async () => {
    const h = harness();
    const res = await h.get('/media/workshop/bench.jpg?w=768&f=webp');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cache-control')).toBe(CACHE_TRANSFORMED);
    expect(res.headers.get('vary')).toBe('Accept');
    expect(await res.text()).toBe('resized:768xauto:scale-down');
    expect(h.images.calls[0]).toEqual({ width: 768, fit: 'scale-down', format: 'image/webp' });

    const crop = await h.get('/media/workshop/bench.jpg?w=320&ar=4:3&f=jpeg');
    expect(await crop.text()).toBe('resized:320x240:cover');
  });

  it('negotiates the format on Accept with f=auto', async () => {
    const h = harness();
    const res = await h.get('/media/workshop/bench.jpg?w=320', { accept: 'image/avif,*/*' });
    expect(res.headers.get('content-type')).toBe('image/avif');
  });

  it('refuses parameters off the menu', async () => {
    const h = harness();
    const res = await h.get('/media/workshop/bench.jpg?w=999');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('BAD_MEDIA_PARAMS');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('honours a custom menu', async () => {
    const h = harness({ menu: menuFromLists('500', '2:1') });
    expect((await h.get('/media/workshop/bench.jpg?w=500&ar=2:1')).status).toBe(200);
    expect((await h.get('/media/workshop/bench.jpg?w=768')).status).toBe(400);
  });

  it('serves as stored without the binding, and says so', async () => {
    const h = harness({ images: false });
    const res = await h.get('/media/workshop/bench.jpg?w=320');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-media-transform')).toBe('unavailable');
    expect(res.headers.get('content-type')).toBe('image/jpeg');
  });

  it('serves a source over the binding cap as stored', async () => {
    const h = harness();
    h.source.put('media/big.jpg', new ArrayBuffer(MAX_TRANSFORM_SOURCE_BYTES + 1), 'image/jpeg');
    const res = await h.get('/media/big.jpg?w=320');
    expect(res.headers.get('x-media-transform')).toBe('too-large');
    expect(h.images.calls).toHaveLength(0);
  });

  it('retries one failed transform, and answers 502 after two', async () => {
    const h = harness();
    h.images.failures = 1;
    expect((await h.get('/media/workshop/bench.jpg?w=320')).status).toBe(200);
    h.images.failures = 2;
    const res = await h.get('/media/workshop/bench.jpg?w=480');
    expect(res.status).toBe(502);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('configuration', () => {
  it('parses served prefixes and refuses malformed ones', () => {
    expect(parsePrefixes(undefined)).toEqual(['media/']);
    expect(parsePrefixes('media/, assets/web/')).toEqual(['media/', 'assets/web/']);
    expect(() => parsePrefixes('media')).toThrow();
    expect(() => parsePrefixes('../x/')).toThrow();
    expect(() => parsePrefixes(' , ')).toThrow();
  });

  it('accepts only image keys under a prefix', () => {
    expect(isServableKey('media/a/b.jpg', ['media/'])).toBe(true);
    expect(isServableKey('media/a//b.jpg', ['media/'])).toBe(false);
    expect(isServableKey('media/a/b.html', ['media/'])).toBe(false);
    expect(isServableKey('mediax/b.jpg', ['media/'])).toBe(false);
  });
});
