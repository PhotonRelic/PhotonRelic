import { usageIndex } from '@photonrelic/media-params';
import { describe, expect, it } from 'vitest';
import {
  AnalyticsEngineUsage,
  chunkIndexes,
  hitListSql,
  hitsSql,
  MAX_KEYS_PER_QUERY,
  sqlLiteral,
  USAGE_PAGE_ROWS,
  type UsageConfig,
  usageConfigFromVars,
} from '../src/usage.js';

const CONFIG: UsageConfig = {
  accountId: 'a'.repeat(32),
  token: 'secret-token',
  dataset: 'photonrelic_usage',
};

/** A fetch that records every statement and answers each from a queue of row sets. */
function fakeApi(answers: (unknown[] | { status: number; body: string })[]) {
  const calls: { url: string; auth: string | null; sql: string }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    calls.push({ url, auth: headers.get('authorization'), sql: String(init.body) });
    const next = answers.shift() ?? [];
    if (Array.isArray(next)) return Response.json({ data: next, rows: next.length });
    return new Response(next.body, { status: next.status });
  };
  return { calls, fetch };
}

describe('configuration', () => {
  it('is off without the token, on with it, and refuses a bad account id or dataset', () => {
    expect(usageConfigFromVars('a'.repeat(32), undefined, undefined)).toBeNull();
    expect(usageConfigFromVars('a'.repeat(32), ' ', undefined)).toBeNull();
    expect(usageConfigFromVars('A'.repeat(32), 'tok', undefined)).toEqual({
      accountId: 'a'.repeat(32),
      token: 'tok',
      dataset: 'photonrelic_usage',
    });
    expect(usageConfigFromVars('a'.repeat(32), 'tok', 'my_usage')?.dataset).toBe('my_usage');
    expect(() => usageConfigFromVars(undefined, 'tok', undefined)).toThrow(/CF_ACCOUNT_ID/);
    expect(() => usageConfigFromVars('short', 'tok', undefined)).toThrow(/CF_ACCOUNT_ID/);
    expect(() => usageConfigFromVars('a'.repeat(32), 'tok', 'bad-name; DROP')).toThrow(/dataset/);
  });
});

describe('statements', () => {
  it('quotes keys as literals, doubling quotes and backslashes', () => {
    expect(sqlLiteral('media/a.jpg')).toBe("'media/a.jpg'");
    expect(sqlLiteral("media/o'neil.jpg")).toBe("'media/o''neil.jpg'");
    expect(sqlLiteral('media/x\\y.jpg')).toBe("'media/x\\\\y.jpg'");
    expect(sqlLiteral("'; DROP TABLE x; --")).toBe("'''; DROP TABLE x; --'");
  });

  it('builds the per-key and the hit-list statements over the window', () => {
    expect(hitsSql('photonrelic_usage', ['media/a.jpg', "media/b'c.jpg"], 7)).toBe(
      'SELECT index1 AS idx, SUM(_sample_interval) AS hits FROM photonrelic_usage ' +
        "WHERE timestamp > NOW() - INTERVAL '7' DAY AND index1 IN ('media/a.jpg', 'media/b''c.jpg') " +
        'GROUP BY index1',
    );
    expect(hitListSql('photonrelic_usage', 90, null, 500)).toBe(
      'SELECT index1 AS idx FROM photonrelic_usage ' +
        "WHERE timestamp > NOW() - INTERVAL '90' DAY " +
        'GROUP BY index1 ORDER BY index1 LIMIT 500',
    );
    expect(hitListSql('photonrelic_usage', 90, 'media/m.jpg')).toContain(
      "AND index1 > 'media/m.jpg' GROUP BY",
    );
  });

  it('bounds the keys in one statement and refuses a window outside retention', () => {
    expect(() => hitsSql('d', [], 7)).toThrow(/keys/);
    expect(() => hitsSql('d', Array(MAX_KEYS_PER_QUERY + 1).fill('k'), 7)).toThrow(/keys/);
    expect(() => hitsSql('d', ['k'], 0)).toThrow(/days/);
    expect(() => hitsSql('d', ['k'], 91)).toThrow(/days/);
    expect(() => hitsSql('d', ['k'], 1.5)).toThrow(/days/);
    const many = Array.from({ length: 250 }, (_, i) => `media/${i}.jpg`);
    expect(chunkIndexes(many).map((c) => c.length)).toEqual([100, 100, 50]);
    // Long keys fill a statement by bytes before they do by count.
    const long = Array.from({ length: 20 }, (_, i) => `media/${'x'.repeat(1000)}${i}.jpg`);
    const chunks = chunkIndexes(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(long);
    expect(chunkIndexes([])).toEqual([]);
  });
});

describe('usageFor', () => {
  it('asks the SQL API with the token, for 7 and 30 days, and maps the rows back to keys', async () => {
    const long = `media/${'n'.repeat(120)}.jpg`;
    const api = fakeApi([
      [{ idx: 'media/a.jpg', hits: '12' }],
      [
        { idx: 'media/a.jpg', hits: 40 },
        { idx: usageIndex(long), hits: 3 },
      ],
    ]);
    const usage = new AnalyticsEngineUsage(CONFIG, api.fetch);
    const counts = await usage.usageFor(['media/a.jpg', 'media/b.jpg', long]);
    expect([...counts]).toEqual([
      ['media/a.jpg', { d7: 12, d30: 40 }],
      [long, { d7: 0, d30: 3 }],
    ]);
    expect(api.calls).toHaveLength(2);
    expect(api.calls[0]?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/analytics_engine/sql`,
    );
    expect(api.calls[0]?.auth).toBe('Bearer secret-token');
    expect(api.calls[0]?.sql).toContain("INTERVAL '7' DAY");
    expect(api.calls[1]?.sql).toContain("INTERVAL '30' DAY");
    // The long key is asked for by its index, never by the key itself.
    expect(api.calls[1]?.sql).toContain(sqlLiteral(usageIndex(long)));
    expect(api.calls[1]?.sql).not.toContain(long);
    expect(api.calls[1]?.sql).toMatch(/ FORMAT JSON$/);
  });

  it('asks nothing for no keys and surfaces an API error', async () => {
    const none = fakeApi([]);
    expect(await new AnalyticsEngineUsage(CONFIG, none.fetch).usageFor([])).toEqual(new Map());
    expect(none.calls).toHaveLength(0);

    const broken = fakeApi([{ status: 401, body: 'Authentication error' }]);
    await expect(
      new AnalyticsEngineUsage(CONFIG, broken.fetch).usageFor(['media/a.jpg']),
    ).rejects.toThrow(/401: Authentication error/);
  });
});

describe('unusedKeys', () => {
  it("subtracts the engine's hit list from the known keys, in order", async () => {
    const api = fakeApi([[{ idx: 'media/b.jpg' }, { idx: 'media/z.jpg' }]]);
    const usage = new AnalyticsEngineUsage(CONFIG, api.fetch);
    const known = ['media/c.jpg', 'media/b.jpg', 'media/a.jpg'];
    expect(await usage.unusedKeys(known)).toEqual(['media/c.jpg', 'media/a.jpg']);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.sql).toContain("INTERVAL '90' DAY");
    expect(api.calls[0]?.sql).toContain(`LIMIT ${USAGE_PAGE_ROWS}`);
    expect(await usage.unusedKeys([])).toEqual([]);
  });

  it('reads a full page, then the next after the last index', async () => {
    const page = Array.from({ length: USAGE_PAGE_ROWS }, (_, i) => ({
      idx: `media/${String(i).padStart(5, '0')}.jpg`,
    }));
    const api = fakeApi([page, [{ idx: 'media/zz.jpg' }]]);
    const usage = new AnalyticsEngineUsage(CONFIG, api.fetch);
    const unused = await usage.unusedKeys(['media/00001.jpg', 'media/zz.jpg', 'media/new.jpg'], 30);
    expect(unused).toEqual(['media/new.jpg']);
    expect(api.calls).toHaveLength(2);
    expect(api.calls[0]?.sql).not.toContain('index1 >');
    expect(api.calls[1]?.sql).toContain(
      `index1 > 'media/${String(USAGE_PAGE_ROWS - 1).padStart(5, '0')}.jpg'`,
    );
    expect(api.calls[1]?.sql).toContain("INTERVAL '30' DAY");
  });
});
