/**
 * Masters: the high-resolution or professional-format originals (an .ai, a
 * .psd, a raw file) a web copy was made from, kept in the bucket under
 * `masters/`, a prefix the resizer refuses by construction. Too large to
 * pass through a Worker, so the browser puts the bytes straight into R2 by
 * presigned URL: one PUT under a part's size, a multipart upload above it.
 * The library starts and completes the upload itself, through the binding,
 * so both are its own audited acts; it only signs the part URLs. On
 * completion it checks the object's size against what the browser declared
 * before linking the master to its web copy.
 *
 * Without the R2 token (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) nothing
 * can be signed: the file page says masters are not configured, and the
 * external master link still works.
 */
import {
  extensionOf,
  MASTER_FORMATS,
  MASTER_MAX_BYTES,
  MASTER_PART_BYTES,
  MASTERS_PREFIX,
  masterKeyFor,
  masterStem,
} from '@photonrelic/media-params';
import { AwsClient } from 'aws4fetch';
import type { Db } from './db.js';
import { getAsset, getAssets, IMAGE_KEY } from './library.js';
import type { MediaBucket, MediaLayout } from './media.js';

export { MASTER_FORMATS, MASTER_MAX_BYTES, MASTER_PART_BYTES, MASTERS_PREFIX };

/** Signs the URLs the browser uploads to. The endpoint origin goes into the page's CSP. */
export interface MasterSigner {
  /** The origin of the signed URLs, for `connect-src`. */
  readonly origin: string;
  /** A PUT of the whole object, good for a quarter of an hour. */
  signPut(key: string): Promise<string>;
  /** A PUT of one part of a multipart upload. */
  signPart(key: string, uploadId: string, partNumber: number): Promise<string>;
}

/** How long a signed URL is good for: enough for a part, not a bearer token to keep. */
export const SIGNED_URL_SECONDS = 900;

export interface R2SignerConfig {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Signs against R2's S3 endpoint with SigV4 query signing (aws4fetch). */
export class R2MasterSigner implements MasterSigner {
  readonly origin: string;
  private readonly client: AwsClient;
  constructor(private readonly config: R2SignerConfig) {
    this.origin = `https://${config.accountId}.r2.cloudflarestorage.com`;
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: 's3',
      region: 'auto',
    });
  }
  private url(key: string, params: Record<string, string> = {}): URL {
    const path = key.split('/').map(encodeURIComponent).join('/');
    const u = new URL(`${this.origin}/${this.config.bucket}/${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set('X-Amz-Expires', String(SIGNED_URL_SECONDS));
    return u;
  }
  private async sign(u: URL): Promise<string> {
    const signed = await this.client.sign(u.toString(), {
      method: 'PUT',
      aws: { signQuery: true },
    });
    return signed.url;
  }
  signPut(key: string): Promise<string> {
    return this.sign(this.url(key));
  }
  signPart(key: string, uploadId: string, partNumber: number): Promise<string> {
    return this.sign(this.url(key, { partNumber: String(partNumber), uploadId }));
  }
}

/**
 * The signer from the Worker's vars and secrets, or null. Half a
 * configuration is a deploy that meant to take masters and will not: it
 * fails loudly rather than quietly saying "not configured".
 */
export function mastersFromVars(vars: {
  accountId?: string | undefined;
  bucket?: string | undefined;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
}): MasterSigner | null {
  const { accountId, bucket, accessKeyId, secretAccessKey } = vars;
  const set = [accessKeyId, secretAccessKey].filter(Boolean).length;
  if (set === 0) return null;
  if (set === 1) throw new Error('R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be set together');
  if (!accountId || !bucket)
    throw new Error('Masters need CF_ACCOUNT_ID and MEDIA_BUCKET beside the R2 token');
  return new R2MasterSigner({
    accountId,
    bucket,
    accessKeyId: accessKeyId as string,
    secretAccessKey: secretAccessKey as string,
  });
}

// ---------------------------------------------------------------------------
// Start and complete
// ---------------------------------------------------------------------------

export type MasterPlan =
  | { mode: 'single'; masterKey: string; url: string }
  | {
      mode: 'multipart';
      masterKey: string;
      uploadId: string;
      partBytes: number;
      parts: { partNumber: number; url: string }[];
    };

export type MasterStart =
  | { ok: true; plan: MasterPlan }
  | { ok: false; status: 400 | 404 | 409 | 413; error: string };

export const MASTER_CONTENT_TYPE = 'application/octet-stream';

/** The number of parts a size takes at the part size. */
export const partsFor = (size: number): number => Math.max(1, Math.ceil(size / MASTER_PART_BYTES));

/**
 * Plans a master upload for a web copy: the key it will have, and the signed
 * URL or part URLs. A master already on file is kept unless `replace` says
 * otherwise, a deliberate act like Replace is for a web copy.
 */
export async function startMaster(
  db: Db,
  media: MediaBucket,
  signer: MasterSigner,
  layout: MediaLayout,
  req: { key: string; name: string; size: number; replace: boolean },
): Promise<MasterStart> {
  const { key, name, size } = req;
  if (!IMAGE_KEY.test(key) || !(await media.head(key)))
    return { ok: false, status: 404, error: 'No such web copy in the bucket.' };
  const masterKey = masterKeyFor(layout.uploadPrefix, key, name);
  if (!masterKey)
    return {
      ok: false,
      status: 400,
      error: `Not a master format (.${extensionOf(name) || '?'}): one of ${MASTER_FORMATS.map((f) => `.${f}`).join(', ')}.`,
    };
  if (!Number.isInteger(size) || size <= 0)
    return { ok: false, status: 400, error: 'The size must be a whole number of bytes.' };
  if (size > MASTER_MAX_BYTES)
    return { ok: false, status: 413, error: `Over ${MASTER_MAX_BYTES / 1024 ** 3} GiB.` };
  const asset = await getAsset(db, key);
  if (asset?.master_key && !req.replace)
    return {
      ok: false,
      status: 409,
      error: `A master is already on file (${asset.master_name ?? asset.master_key}); tick Replace to put a new one over it.`,
    };
  if (size <= MASTER_PART_BYTES) {
    return { ok: true, plan: { mode: 'single', masterKey, url: await signer.signPut(masterKey) } };
  }
  const { uploadId } = await media.createMultipart(masterKey, MASTER_CONTENT_TYPE);
  const parts = [];
  for (let n = 1; n <= partsFor(size); n++)
    parts.push({ partNumber: n, url: await signer.signPart(masterKey, uploadId, n) });
  return {
    ok: true,
    plan: { mode: 'multipart', masterKey, uploadId, partBytes: MASTER_PART_BYTES, parts },
  };
}

export type MasterComplete =
  | { ok: true; masterKey: string; bytes: number; replaced: string | null }
  | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Finishes an upload: completes the multipart when there is one, checks the
 * object is there at the declared size, links it to the web copy, and
 * removes a master it replaced when that one had another key (a .psd put
 * over a .tif). A size that does not match is refused and the object
 * removed: a half-upload must not pass as a master.
 */
export async function completeMaster(
  db: Db,
  media: MediaBucket,
  layout: MediaLayout,
  req: {
    key: string;
    name: string;
    size: number;
    uploadId?: string | undefined;
    parts?: { partNumber: number; etag: string }[] | undefined;
  },
): Promise<MasterComplete> {
  const masterKey = masterKeyFor(layout.uploadPrefix, req.key, req.name);
  if (!masterKey) return { ok: false, status: 400, error: 'Not a master for this key.' };
  const asset = await getAsset(db, req.key);
  if (!asset) return { ok: false, status: 404, error: 'No such web copy.' };
  if (req.uploadId) {
    if (!req.parts?.length) return { ok: false, status: 400, error: 'No parts to complete.' };
    try {
      await media.completeMultipart(masterKey, req.uploadId, req.parts);
    } catch (e) {
      return {
        ok: false,
        status: 409,
        error: `The upload could not be completed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
  const head = await media.head(masterKey);
  if (!head) return { ok: false, status: 404, error: 'The master did not arrive.' };
  if (head.size !== req.size) {
    await media.delete(masterKey);
    return {
      ok: false,
      status: 409,
      error: `The master arrived at ${head.size} bytes, not the ${req.size} declared; removed.`,
    };
  }
  const replaced = asset.master_key && asset.master_key !== masterKey ? asset.master_key : null;
  if (replaced) await media.delete(replaced);
  await db
    .prepare('UPDATE assets SET master_key = ?2, master_name = ?3 WHERE key = ?1')
    .bind(req.key, masterKey, req.name.replace(/\s+/g, ' ').trim())
    .run();
  return { ok: true, masterKey, bytes: head.size, replaced };
}

/** Removes a master from the bucket and the link to it; the recorded name stays, since it still finds the file in a backup. */
export async function removeMaster(
  db: Db,
  media: MediaBucket,
  key: string,
): Promise<string | null> {
  const asset = await getAsset(db, key);
  if (!asset?.master_key) return null;
  await media.delete(asset.master_key);
  await db.prepare('UPDATE assets SET master_key = NULL WHERE key = ?1').bind(key).run();
  return asset.master_key;
}

// ---------------------------------------------------------------------------
// Rescan: link what the bucket holds under masters/
// ---------------------------------------------------------------------------

export interface MastersReport {
  /** Objects under masters/. */
  masters: number;
  /** Web copies given a master they lacked. */
  linked: number;
  /** Rows whose master object is gone, unlinked. */
  unlinked: number;
  /** Masters with no web copy to belong to. */
  orphans: number;
}

const WEB_EXT = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif'];

/**
 * Walks `masters/` and links each master to the web copy with the same stem
 * under the upload prefix (`masters/psi/party.psd` to `media/psi/party.jpg`),
 * where the row has no master yet; a row whose master object is gone is
 * unlinked. Masters with no web copy are counted, not touched: deleting is a
 * person's act.
 */
export async function linkMasters(
  db: Db,
  media: MediaBucket,
  layout: MediaLayout,
): Promise<MastersReport> {
  const present = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await media.list(MASTERS_PREFIX, { limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const o of page.objects) present.add(o.key);
    cursor = page.cursor ?? undefined;
  } while (cursor);

  let linked = 0;
  let orphans = 0;
  const keys = [...present];
  for (let i = 0; i < keys.length; i += 15) {
    const chunk = keys.slice(i, i + 15);
    const candidates = new Map<string, string>(); // web key → master key
    for (const masterKey of chunk) {
      const stem = masterStem(masterKey.slice(MASTERS_PREFIX.length));
      for (const ext of WEB_EXT) candidates.set(`${layout.uploadPrefix}${stem}.${ext}`, masterKey);
    }
    const rows = await getAssets(db, [...candidates.keys()]);
    const found = new Set<string>();
    for (const [webKey, masterKey] of candidates) {
      const row = rows.get(webKey);
      if (!row) continue;
      found.add(masterKey);
      if (row.master_key === masterKey) continue;
      if (row.master_key && present.has(row.master_key)) continue; // keeps the one it has
      await db
        .prepare(
          'UPDATE assets SET master_key = ?2, master_name = COALESCE(master_name, ?3) WHERE key = ?1',
        )
        .bind(webKey, masterKey, masterKey.slice(masterKey.lastIndexOf('/') + 1))
        .run();
      linked++;
    }
    orphans += chunk.filter((k) => !found.has(k)).length;
  }
  const { results } = await db
    .prepare('SELECT key, master_key FROM assets WHERE master_key IS NOT NULL')
    .all<{ key: string; master_key: string }>();
  let unlinked = 0;
  for (const r of results) {
    if (present.has(r.master_key)) continue;
    await db.prepare('UPDATE assets SET master_key = NULL WHERE key = ?1').bind(r.key).run();
    unlinked++;
  }
  return { masters: present.size, linked, unlinked, orphans };
}
