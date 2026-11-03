/**
 * Worker bindings and variables (wrangler.toml). Nothing here is a secret
 * except ANALYTICS_TOKEN (`wrangler secret put`); DEV_IDENTITY comes from
 * .dev.vars in local development only.
 */
export interface Env {
  /** The library's metadata and audit log. */
  DB: D1Database;
  /** The media bucket. */
  MEDIA?: R2Bucket;
  /** Static assets (design system, fonts, vendored libraries). */
  ASSETS?: Fetcher;

  ENVIRONMENT: string;
  /** Cloudflare Access team domain, e.g. yourteam.cloudflareaccess.com. */
  ACCESS_TEAM_DOMAIN: string;
  /** The Access application's AUD tag. Unset only in local development. */
  ACCESS_AUD?: string;
  /** The resizer's public origin, for thumbnails; unset, previews stream through this Worker. */
  MEDIA_ORIGIN?: string;
  /**
   * The resizer's menu, for the file page's embed markup: the same lists as
   * the resizer's MEDIA_WIDTHS and MEDIA_ASPECTS, and they must match, or the
   * copied markup asks for sizes the resizer refuses. Unset keeps the default menu.
   */
  MEDIA_WIDTHS?: string;
  MEDIA_ASPECTS?: string;
  /** The zone the resizer's hostname is in; with CACHE_PURGE_TOKEN, turns the purge on. */
  CF_ZONE_ID?: string;
  /** A secret (`wrangler secret put`): an API token with Zone → Cache Purge → Purge. */
  CACHE_PURGE_TOKEN?: string;
  /** Where uploads go; default `media/`. */
  UPLOAD_PREFIX?: string;
  /** Comma-separated roots the library lists; UPLOAD_PREFIX is always one. */
  LIBRARY_PREFIXES?: string;
  /** Local development only: the identity to trust when ACCESS_AUD is unset. */
  DEV_IDENTITY?: string;
  /** The account whose Analytics Engine holds the resizer's usage dataset. */
  CF_ACCOUNT_ID?: string;
  /** A secret: an API token with Account Analytics Read. Set, it turns usage on. */
  ANALYTICS_TOKEN?: string;
  /** The resizer's dataset name; default `photonrelic_usage`. */
  USAGE_DATASET?: string;
  /** The media bucket's name (the same as the MEDIA binding's), for signing master uploads. */
  MEDIA_BUCKET?: string;
  /** Secrets: an R2 API token (Object Read & Write on the one bucket) that signs master uploads. */
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}
