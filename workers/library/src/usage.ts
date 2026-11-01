/**
 * How often each file is served, read back from the Workers Analytics Engine
 * dataset the resizer writes (workers/resizer/src/usage.ts) through the
 * engine's SQL API. Optional: without CF_ACCOUNT_ID and ANALYTICS_TOKEN the
 * file page says "not configured" and nothing else changes.
 *
 * Two caveats, repeated where the numbers are shown. At high volume the
 * engine samples, per index, so a count is SUM(_sample_interval): an estimate,
 * exact while traffic is modest. And the engine keeps 90 days, so "unused"
 * means "not served in the last 90 days", never "never served".
 *
 * The SQL API has no bind parameters: keys go into the statement as quoted
 * literals, escaped, and one statement carries a bounded number of them.
 */
import { usageIndex } from '@photonrelic/media-params';

export interface UsageCounts {
  /** Estimated hits in the last 7 days. */
  d7: number;
  /** Estimated hits in the last 30 days. */
  d30: number;
}

export interface UsageReader {
  /** Hits per key over the last 7 and 30 days; a key nothing asked for is absent. */
  usageFor(keys: string[]): Promise<Map<string, UsageCounts>>;
  /** Of the known keys, those with no hits in the last `days` days, in the order given. */
  unusedKeys(knownKeys: string[], days?: number): Promise<string[]>;
}

export interface UsageConfig {
  accountId: string;
  token: string;
  dataset: string;
}

export const DEFAULT_USAGE_DATASET = 'photonrelic_usage';
/** The engine keeps data points this long; nothing older can be asked about. */
export const USAGE_RETENTION_DAYS = 90;
/** Keys in one IN list. The API caps a statement at 10 KiB and an R2 key can be 1 KiB, so bytes are bounded too. */
export const MAX_KEYS_PER_QUERY = 100;
const MAX_LITERAL_BYTES = 8 * 1024;
/**
 * Rows assumed to come back from one statement at most. The SQL API does
 * not document a cap for this dataset, so the hit list is read in pages of
 * this size, keyed on the index, and a page that comes back full is followed
 * by the next.
 */
export const USAGE_PAGE_ROWS = 10_000;
const MAX_PAGES = 100;

const DATASET = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ACCOUNT = /^[0-9a-f]{32}$/;

/**
 * The reader's configuration from the vars. The token turns it on; with the
 * token set, a missing or malformed account id or dataset name is a bad
 * deploy and throws, as a bad prefix does.
 */
export function usageConfigFromVars(
  accountId: string | undefined,
  token: string | undefined,
  dataset: string | undefined,
): UsageConfig | null {
  if (!token?.trim()) return null;
  const account = (accountId ?? '').trim().toLowerCase();
  if (!ACCOUNT.test(account)) throw new Error('CF_ACCOUNT_ID must be the 32-character account id');
  const name = (dataset ?? '').trim() || DEFAULT_USAGE_DATASET;
  if (!DATASET.test(name)) throw new Error(`Not an Analytics Engine dataset name: ${name}`);
  return { accountId: account, token: token.trim(), dataset: name };
}

/** A string as a single-quoted SQL literal. Quotes are doubled; a backslash, an escape in this dialect, too. */
export const sqlLiteral = (s: string): string =>
  `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;

const wholeDays = (days: number): number => {
  if (!Number.isInteger(days) || days < 1 || days > USAGE_RETENTION_DAYS)
    throw new Error(`days must be 1 to ${USAGE_RETENTION_DAYS}`);
  return days;
};

/** Estimated hits per index for these indexes over the last `days` days. */
export function hitsSql(dataset: string, indexes: string[], days: number): string {
  if (indexes.length === 0 || indexes.length > MAX_KEYS_PER_QUERY)
    throw new Error(`1 to ${MAX_KEYS_PER_QUERY} keys per query`);
  const list = indexes.map(sqlLiteral).join(', ');
  return (
    `SELECT index1 AS idx, SUM(_sample_interval) AS hits FROM ${dataset} ` +
    `WHERE timestamp > NOW() - INTERVAL '${wholeDays(days)}' DAY AND index1 IN (${list}) ` +
    'GROUP BY index1'
  );
}

/** One page of the indexes with any hit in the last `days` days, in index order, after `after`. */
export function hitListSql(
  dataset: string,
  days: number,
  after: string | null,
  limit = USAGE_PAGE_ROWS,
): string {
  const cursor = after === null ? '' : ` AND index1 > ${sqlLiteral(after)}`;
  return (
    `SELECT index1 AS idx FROM ${dataset} ` +
    `WHERE timestamp > NOW() - INTERVAL '${wholeDays(days)}' DAY${cursor} ` +
    `GROUP BY index1 ORDER BY index1 LIMIT ${limit}`
  );
}

/** Index lists sized for one statement: at most MAX_KEYS_PER_QUERY, at most MAX_LITERAL_BYTES of literals. */
export function chunkIndexes(indexes: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  const size = (s: string) => new TextEncoder().encode(s).byteLength + 4;
  for (const idx of indexes) {
    const n = size(idx);
    if (
      current.length > 0 &&
      (current.length >= MAX_KEYS_PER_QUERY || bytes + n > MAX_LITERAL_BYTES)
    ) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(idx);
    bytes += n;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

interface SqlRow {
  idx?: unknown;
  hits?: unknown;
}

export class AnalyticsEngineUsage implements UsageReader {
  constructor(
    private readonly config: UsageConfig,
    private readonly fetch: Fetch = (url, init) => globalThis.fetch(url, init),
  ) {}

  /** Run one statement; the API answers JSON with the rows under `data`. */
  async query(sql: string): Promise<SqlRow[]> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}/analytics_engine/sql`;
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.token}` },
      body: `${sql} FORMAT JSON`,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Analytics Engine SQL API answered ${res.status}: ${text.slice(0, 200)}`);
    }
    let parsed: { data?: unknown };
    try {
      parsed = JSON.parse(text) as { data?: unknown };
    } catch {
      throw new Error('Analytics Engine SQL API answered something other than JSON');
    }
    return Array.isArray(parsed.data) ? (parsed.data as SqlRow[]) : [];
  }

  /** Hits per index for a bounded list of indexes. The engine's 64-bit sums may arrive as strings. */
  private async hitsByIndex(indexes: string[], days: number): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const row of await this.query(hitsSql(this.config.dataset, indexes, days))) {
      if (typeof row.idx !== 'string') continue;
      const n = Number(row.hits);
      out.set(row.idx, Number.isFinite(n) ? Math.round(n) : 0);
    }
    return out;
  }

  async usageFor(keys: string[]): Promise<Map<string, UsageCounts>> {
    const byIndex = new Map<string, string>();
    for (const key of new Set(keys)) byIndex.set(usageIndex(key), key);
    const out = new Map<string, UsageCounts>();
    for (const chunk of chunkIndexes([...byIndex.keys()])) {
      const [d7, d30] = await Promise.all([
        this.hitsByIndex(chunk, 7),
        this.hitsByIndex(chunk, 30),
      ]);
      for (const [idx, hits] of d30) {
        const key = byIndex.get(idx);
        if (key) out.set(key, { d7: d7.get(idx) ?? 0, d30: hits });
      }
    }
    return out;
  }

  /** Every index with a hit in the window, page by page. */
  private async hitIndexes(days: number): Promise<Set<string>> {
    const hit = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await this.query(hitListSql(this.config.dataset, days, after));
      let last: string | null = null;
      for (const row of rows) {
        if (typeof row.idx !== 'string') continue;
        hit.add(row.idx);
        last = row.idx;
      }
      if (rows.length < USAGE_PAGE_ROWS || last === null) return hit;
      after = last;
    }
    throw new Error(`More than ${MAX_PAGES * USAGE_PAGE_ROWS} keys with hits; stopped reading`);
  }

  async unusedKeys(knownKeys: string[], days = USAGE_RETENTION_DAYS): Promise<string[]> {
    if (knownKeys.length === 0) return [];
    const hit = await this.hitIndexes(days);
    return knownKeys.filter((key) => !hit.has(usageIndex(key)));
  }
}
