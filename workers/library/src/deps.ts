/**
 * Everything a handler needs that is not the request. Built once per isolate
 * from the env (index.tsx) or from fakes (tests).
 */
import { mediaUrl } from '@photonrelic/media-params';
import type { AccessVerifier } from './access.js';
import type { Db } from './db.js';
import type { MediaBucket, MediaLayout } from './media.js';

export interface AppDeps {
  db: Db;
  access: AccessVerifier;
  /** The media bucket; null when unbound, and every page says so. */
  media: MediaBucket | null;
  layout: MediaLayout;
  /** The resizer's public origin, no trailing slash; null streams previews through /library/raw. */
  mediaOrigin: string | null;
  environment: string;
  now: () => Date;
}

/** A preview of a key at a width: resized by the resizer, or streamed whole when there is none. */
export function previewUrl(deps: AppDeps, key: string, width?: number): string {
  if (deps.mediaOrigin) return mediaUrl(deps.mediaOrigin, key, width ? { w: width } : {});
  return `/library/raw?key=${encodeURIComponent(key)}`;
}

/** The URL a site would use for a key: the resizer's, or none when it is not configured. */
export const publicUrl = (deps: AppDeps, key: string): string | null =>
  deps.mediaOrigin ? mediaUrl(deps.mediaOrigin, key) : null;
