/**
 * Worker bindings and variables (wrangler.toml). Nothing here is a secret;
 * DEV_IDENTITY comes from .dev.vars in local development only.
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
  /** Where uploads go; default `media/`. */
  UPLOAD_PREFIX?: string;
  /** Comma-separated roots the library lists; UPLOAD_PREFIX is always one. */
  LIBRARY_PREFIXES?: string;
  /** Local development only: the identity to trust when ACCESS_AUD is unset. */
  DEV_IDENTITY?: string;
}
