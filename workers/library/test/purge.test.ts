import { describe, expect, it } from 'vitest';
import { PURGE_CHUNK, purgeUrls } from '../src/purge.js';
import { fakePurge } from './helpers.js';

const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://img.example.com/${i}.jpg`);

describe('purgeUrls', () => {
  it('does nothing and says so without a configuration', async () => {
    expect(await purgeUrls(null, urls(5))).toEqual({ configured: false, urls: 0, error: null });
  });

  it('sends the zone endpoint thirty URLs at a time with the bearer token', async () => {
    const fake = fakePurge();
    const r = await purgeUrls(fake.config, urls(PURGE_CHUNK * 2 + 1));
    expect(r).toEqual({ configured: true, urls: 61, error: null });
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls.map((c) => c.files.length)).toEqual([30, 30, 1]);
    expect(fake.calls[0]?.url).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone123/purge_cache',
    );
    expect(fake.calls[0]?.headers.authorization).toBe('Bearer secret-token');
    expect(fake.urls()).toEqual(urls(61));
  });

  it('sends nothing for an empty list', async () => {
    const fake = fakePurge();
    expect(await purgeUrls(fake.config, [])).toEqual({ configured: true, urls: 0, error: null });
    expect(fake.calls).toHaveLength(0);
  });

  it('stops at the first failure and reports it, never throwing', async () => {
    let n = 0;
    const refused = fakePurge(() =>
      ++n === 2
        ? Response.json(
            { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
            { status: 403 },
          )
        : Response.json({ success: true, errors: [] }),
    );
    expect(await purgeUrls(refused.config, urls(70))).toEqual({
      configured: true,
      urls: 30,
      error: 'Authentication error',
    });
    expect(refused.calls).toHaveLength(2);

    const blank = fakePurge(() => new Response('gateway timeout', { status: 504 }));
    expect((await purgeUrls(blank.config, urls(1))).error).toBe('HTTP 504');

    const down = fakePurge(() => {
      throw new Error('connection reset');
    });
    expect((await purgeUrls(down.config, urls(1))).error).toBe('connection reset');
  });
});
