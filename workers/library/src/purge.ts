/**
 * Purging the edge cache after a key's bytes change (Replace, a Rescan that
 * finds a different etag) or go away (Delete). The resizer caches output for
 * a day, so without this a replaced image keeps serving its old self; with a
 * zone id and a token that may purge the zone, every URL the edge may hold
 * for the key is dropped (`variantUrls` in media-params). Unconfigured, the
 * helper does nothing and says so, so the UI can promise a day instead.
 */

export interface PurgeConfig {
  /** The zone the resizer's hostname is in. */
  zoneId: string;
  /** An API token with Zone → Cache Purge → Purge on that zone. */
  token: string;
  /** Injected so tests can fake the API. */
  fetch: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<Response>;
}

export interface PurgeResult {
  /** False when no zone or token is set: nothing was asked of the edge. */
  configured: boolean;
  /** How many URLs were sent before the first failure, or all of them. */
  urls: number;
  /** Why a purge stopped; null when every chunk was accepted. */
  error: string | null;
}

/** The API takes at most this many URLs per request. */
export const PURGE_CHUNK = 30;

interface Envelope {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
}

/**
 * Purge URLs from the zone's cache, thirty at a time, in order, stopping at
 * the first failure. Never throws: the caller logs the error and tells the
 * person; the write that caused the purge has already happened.
 */
export async function purgeUrls(cfg: PurgeConfig | null, urls: string[]): Promise<PurgeResult> {
  if (!cfg) return { configured: false, urls: 0, error: null };
  let sent = 0;
  for (let i = 0; i < urls.length; i += PURGE_CHUNK) {
    const files = urls.slice(i, i + PURGE_CHUNK);
    let res: Response;
    try {
      res = await cfg.fetch(
        `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(cfg.zoneId)}/purge_cache`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${cfg.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ files }),
        },
      );
    } catch (e) {
      return { configured: true, urls: sent, error: e instanceof Error ? e.message : String(e) };
    }
    const body = (await res.json().catch(() => null)) as Envelope | null;
    if (!res.ok || !body?.success) {
      const why = body?.errors?.[0]?.message ?? `HTTP ${res.status}`;
      return { configured: true, urls: sent, error: why };
    }
    sent += files.length;
  }
  return { configured: true, urls: sent, error: null };
}
