import { MASTER_PART_BYTES, masterKeyFor, masterStem } from '@photonrelic/media-params';
import { describe, expect, it } from 'vitest';
import { recentActions } from '../src/audit.js';
import { getAsset, type SearchFilters, searchAssets } from '../src/library.js';
import { linkMasters, mastersFromVars, partsFor, R2MasterSigner } from '../src/masters.js';
import { bytes, FakeSigner, harness, png, STAFF, text } from './helpers.js';

const KEY = 'media/psi/party.jpg';
const ALL: SearchFilters = { q: '', subject: null, tag: null, camera: null, state: 'all' };

type H = ReturnType<typeof harness>;

/** The browser's side of a plan: PUT the bytes where the signed URLs say, into the memory bucket. */
async function playBrowser(
  h: H,
  plan: {
    mode: string;
    masterKey: string;
    url?: string;
    uploadId?: string;
    parts?: { partNumber: number; url: string }[];
    partBytes?: number;
  },
  body: ArrayBuffer,
) {
  if (plan.mode === 'single') {
    expect(plan.url).toContain(`/bucket/${plan.masterKey}?`);
    await h.media.put(plan.masterKey, body, 'application/octet-stream');
    return undefined;
  }
  const parts = [];
  for (const p of plan.parts ?? []) {
    expect(p.url).toContain(`partNumber=${p.partNumber}&uploadId=${plan.uploadId}`);
    const start = (p.partNumber - 1) * (plan.partBytes ?? 0);
    const slice = body.slice(start, Math.min(body.byteLength, start + (plan.partBytes ?? 0)));
    parts.push({
      partNumber: p.partNumber,
      etag: await h.media.putPart(plan.uploadId ?? '', p.partNumber, slice),
    });
  }
  return parts;
}

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

const post = (h: H, path: string, body: unknown) =>
  h.req(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** A web copy with a master uploaded and completed beside it; returns the master's key. */
async function withMaster(h: H, name = 'party.psd', content = 'master bytes') {
  await h.put(KEY, bytes('web'));
  const master = text(content);
  const plan = (await json(
    await post(h, '/library/file/master/start', { key: KEY, name, size: master.byteLength }),
  )) as { mode: string; masterKey: string; url: string };
  await playBrowser(h, plan, master);
  await post(h, '/library/file/master/complete', { key: KEY, name, size: master.byteLength });
  return plan.masterKey;
}

describe('master keys', () => {
  it('mirror the web key under masters/ with the master’s own extension', () => {
    expect(masterKeyFor('media/', KEY, 'Party Final.PSD')).toBe('masters/psi/party.psd');
    expect(masterKeyFor('media/', 'media/a/b/c.png', 'x.ai')).toBe('masters/a/b/c.ai');
    expect(masterKeyFor('media/', KEY, 'party.jpg')).toBeNull(); // a web format is not a master
    expect(masterKeyFor('media/', KEY, 'noext')).toBeNull();
    expect(masterKeyFor('media/', 'legacy/x.jpg', 'x.ai')).toBeNull(); // not under the upload prefix
    expect(masterStem('psi/Party.PSD')).toBe('psi/party');
    expect(partsFor(1)).toBe(1);
    expect(partsFor(MASTER_PART_BYTES)).toBe(1);
    expect(partsFor(MASTER_PART_BYTES + 1)).toBe(2);
  });

  it('builds the signer from the vars, and refuses half a configuration', () => {
    expect(mastersFromVars({})).toBeNull();
    expect(() => mastersFromVars({ accessKeyId: 'a' })).toThrow(/together/);
    expect(() => mastersFromVars({ accessKeyId: 'a', secretAccessKey: 'b' })).toThrow(
      /CF_ACCOUNT_ID/,
    );
    const signer = mastersFromVars({
      accountId: 'acct',
      bucket: 'media',
      accessKeyId: 'a',
      secretAccessKey: 'b',
    });
    expect(signer).toBeInstanceOf(R2MasterSigner);
    expect(signer?.origin).toBe('https://acct.r2.cloudflarestorage.com');
  });

  it('signs R2 URLs with SigV4 in the query, bound to the key, the part and a short expiry', async () => {
    const signer = new R2MasterSigner({
      accountId: 'acct',
      bucket: 'media',
      accessKeyId: 'AKID',
      secretAccessKey: 'secret',
    });
    const put = new URL(await signer.signPut('masters/psi/party.psd'));
    expect(put.origin).toBe('https://acct.r2.cloudflarestorage.com');
    expect(put.pathname).toBe('/media/masters/psi/party.psd');
    expect(put.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(put.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(put.searchParams.get('X-Amz-Credential')).toMatch(
      /^AKID\/\d{8}\/auto\/s3\/aws4_request$/,
    );
    expect(put.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    const part = new URL(await signer.signPart('masters/psi/party.psd', 'up1', 3));
    expect(part.searchParams.get('partNumber')).toBe('3');
    expect(part.searchParams.get('uploadId')).toBe('up1');
    expect(part.searchParams.get('X-Amz-Signature')).not.toBe(
      put.searchParams.get('X-Amz-Signature'),
    );
  });
});

describe('uploading a master from the file page', () => {
  it('says so when not configured, and the file page offers the external link only', async () => {
    const h = harness();
    await h.put(KEY, bytes('web'));
    const res = await post(h, '/library/file/master/start', {
      key: KEY,
      name: 'party.psd',
      size: 10,
    });
    expect(res.status).toBe(503);
    expect((await json(res)).error).toMatch(/not configured/);
    const page = await (await h.req(`/library/file?key=${encodeURIComponent(KEY)}`)).text();
    expect(page).toContain('Master uploads are not configured');
    expect(page).not.toContain('id="pr-master-file"');
  });

  it('plans one signed PUT for a small master, then completes, links and audits it', async () => {
    const signer = new FakeSigner();
    const h = harness({ masters: signer });
    await h.put(KEY, bytes('web'));
    const master = bytes('%!PS-Adobe master bytes');
    const start = await post(h, '/library/file/master/start', {
      key: KEY,
      name: 'Party Final.PSD',
      size: master.byteLength,
    });
    expect(start.status).toBe(200);
    const plan = (await json(start)) as { mode: string; masterKey: string; url: string };
    expect(plan.mode).toBe('single');
    expect(plan.masterKey).toBe('masters/psi/party.psd');
    await playBrowser(h, plan, master);
    const done = await post(h, '/library/file/master/complete', {
      key: KEY,
      name: 'Party Final.PSD',
      size: master.byteLength,
    });
    expect(done.status).toBe(200);
    expect(await getAsset(h.db, KEY)).toMatchObject({
      master_key: 'masters/psi/party.psd',
      master_name: 'Party Final.PSD',
    });
    const actions = (await recentActions(h.db, 3)).map((a) => a.action);
    expect(actions).toEqual([
      'library.master_uploaded',
      'library.master_started',
      'library.uploaded',
    ]);
    expect(done.headers.get('set-cookie')).toContain('pr_flash=');
    const page = await (await h.req(`/library/file?key=${encodeURIComponent(KEY)}`)).text();
    expect(page).toContain('Party Final.PSD');
    expect(page).toContain('/library/master?key=media%2Fpsi%2Fparty.jpg');
    expect(page).toContain('Also delete its master');
    const csp = (await h.req(`/library/file?key=${encodeURIComponent(KEY)}`)).headers.get(
      'content-security-policy',
    );
    expect(csp).toContain("connect-src 'self' https://r2.test");
  });

  it('plans a multipart upload above a part, with a signed URL per part, and completes from the ETags', async () => {
    const h = harness({ masters: new FakeSigner() });
    await h.put(KEY, bytes('web'));
    const size = MASTER_PART_BYTES * 2 + 5;
    const start = await post(h, '/library/file/master/start', { key: KEY, name: 'big.psb', size });
    const plan = (await json(start)) as {
      mode: string;
      masterKey: string;
      uploadId: string;
      partBytes: number;
      parts: { partNumber: number; url: string }[];
    };
    expect(plan.mode).toBe('multipart');
    expect(plan.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    expect(plan.partBytes).toBe(MASTER_PART_BYTES);
    expect(h.media.multipart.has(plan.uploadId)).toBe(true);
    // The bytes: three parts, the last five bytes long. Only the memory bucket's bookkeeping is big.
    const body = new Uint8Array(size);
    body.fill(7);
    body[size - 1] = 9;
    const parts = await playBrowser(h, plan, body.buffer as ArrayBuffer);
    const done = await post(h, '/library/file/master/complete', {
      key: KEY,
      name: 'big.psb',
      size,
      uploadId: plan.uploadId,
      parts,
    });
    expect(done.status).toBe(200);
    expect(h.media.multipart.has(plan.uploadId)).toBe(false);
    expect((await h.media.head('masters/psi/party.psb'))?.size).toBe(size);
    expect((await getAsset(h.db, KEY))?.master_key).toBe('masters/psi/party.psb');
    // A bad part set cannot complete; the abort route drops the upload.
    const again = await post(h, '/library/file/master/start', {
      key: KEY,
      name: 'big.psb',
      size,
      replace: true,
    });
    const plan2 = (await json(again)) as { uploadId: string; masterKey: string };
    const bad = await post(h, '/library/file/master/complete', {
      key: KEY,
      name: 'big.psb',
      size,
      uploadId: plan2.uploadId,
      parts: [{ partNumber: 1, etag: 'nope' }],
    });
    expect(bad.status).toBe(409);
    const aborted = await post(h, '/library/file/master/abort', {
      masterKey: plan2.masterKey,
      uploadId: plan2.uploadId,
    });
    expect(aborted.status).toBe(200);
    expect(h.media.multipart.has(plan2.uploadId)).toBe(false);
  });

  it('refuses a second master unless Replace is ticked, and removes a replaced master of another format', async () => {
    const h = harness({ masters: new FakeSigner() });
    await h.put(KEY, bytes('web'));
    const first = bytes('tif master');
    const p1 = (await json(
      await post(h, '/library/file/master/start', {
        key: KEY,
        name: 'party.tif',
        size: first.byteLength,
      }),
    )) as { mode: string; masterKey: string; url: string };
    await playBrowser(h, p1, first);
    await post(h, '/library/file/master/complete', {
      key: KEY,
      name: 'party.tif',
      size: first.byteLength,
    });
    const refused = await post(h, '/library/file/master/start', {
      key: KEY,
      name: 'party.psd',
      size: 5,
    });
    expect(refused.status).toBe(409);
    expect((await json(refused)).error).toContain('party.tif');
    const second = bytes('psd master!');
    const p2 = (await json(
      await post(h, '/library/file/master/start', {
        key: KEY,
        name: 'party.psd',
        size: second.byteLength,
        replace: true,
      }),
    )) as { mode: string; masterKey: string; url: string };
    await playBrowser(h, p2, second);
    const done = await post(h, '/library/file/master/complete', {
      key: KEY,
      name: 'party.psd',
      size: second.byteLength,
    });
    expect(done.status).toBe(200);
    expect(h.media.objects.has('masters/psi/party.tif')).toBe(false);
    expect(h.media.objects.has('masters/psi/party.psd')).toBe(true);
    expect((await getAsset(h.db, KEY))?.master_key).toBe('masters/psi/party.psd');
  });

  it('refuses a web format, an unknown key, an oversize master, and a size that does not match', async () => {
    const h = harness({ masters: new FakeSigner() });
    await h.put(KEY, bytes('web'));
    expect(
      (await post(h, '/library/file/master/start', { key: KEY, name: 'party.jpg', size: 5 }))
        .status,
    ).toBe(400);
    expect(
      (
        await post(h, '/library/file/master/start', {
          key: 'media/psi/none.jpg',
          name: 'x.psd',
          size: 5,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post(h, '/library/file/master/start', {
          key: 'private/x.jpg',
          name: 'x.psd',
          size: 5,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post(h, '/library/file/master/start', {
          key: KEY,
          name: 'x.psd',
          size: 6 * 1024 ** 3,
        })
      ).status,
    ).toBe(413);
    expect((await post(h, '/library/file/master/start', { key: KEY, name: 'x.psd' })).status).toBe(
      400,
    );
    const plan = (await json(
      await post(h, '/library/file/master/start', { key: KEY, name: 'x.psd', size: 100 }),
    )) as { mode: string; masterKey: string; url: string };
    await playBrowser(h, plan, bytes('short'));
    const done = await post(h, '/library/file/master/complete', {
      key: KEY,
      name: 'x.psd',
      size: 100,
    });
    expect(done.status).toBe(409);
    expect((await json(done)).error).toMatch(/removed/);
    expect(h.media.objects.has('masters/psi/party.psd')).toBe(false);
    expect((await getAsset(h.db, KEY))?.master_key).toBeNull();
    // Taking the half-upload out again is an act, and is in the log.
    expect((await recentActions(h.db, 1))[0]?.action).toBe('library.master_removed');
    // With the upload over, there is nothing left to complete.
    const again = await post(h, '/library/file/master/complete', {
      key: KEY,
      name: 'x.psd',
      size: 100,
    });
    expect(again.status).toBe(409);
    expect((await json(again)).error).toMatch(/No upload/);
  });

  it('never removes a master on file through a completion it did not start', async () => {
    const h = harness({ masters: new FakeSigner() });
    const masterKey = await withMaster(h, 'party.psd', 'the real master');
    expect(h.media.objects.has(masterKey)).toBe(true);
    // A stray completion naming the same master with a wrong size: before, this
    // deleted the master on file; now there is no upload to complete.
    const stray = await post(h, '/library/file/master/complete', {
      key: KEY,
      name: 'party.psd',
      size: 1,
    });
    expect(stray.status).toBe(409);
    expect((await json(stray)).error).toMatch(/No upload/);
    expect(h.media.objects.has(masterKey)).toBe(true);
    expect((await getAsset(h.db, KEY))?.master_key).toBe(masterKey);
    // An abort needs the upload it names, and is logged when it happens.
    const nobody = await post(h, '/library/file/master/abort', {
      masterKey,
      uploadId: 'not-an-upload',
    });
    expect(nobody.status).toBe(404);
    const big = (await json(
      await post(h, '/library/file/master/start', {
        key: KEY,
        name: 'party.psd',
        size: MASTER_PART_BYTES + 1,
        replace: true,
      }),
    )) as { uploadId: string; masterKey: string };
    const aborted = await post(h, '/library/file/master/abort', {
      masterKey: big.masterKey,
      uploadId: big.uploadId,
    });
    expect(aborted.status).toBe(200);
    expect((await recentActions(h.db, 1))[0]?.action).toBe('library.master_aborted');
    expect(h.media.multipart.has(big.uploadId)).toBe(false);
    // The master on file was never touched by any of this.
    expect(h.media.objects.has(masterKey)).toBe(true);
  });

  it('refuses a plain upload over an unlinked object at the master key, and a name that is not one line', async () => {
    const h = harness({ masters: new FakeSigner() });
    await h.put(KEY, bytes('web'));
    await h.media.put(
      'masters/psi/party.psd',
      text('put here some other way'),
      'application/octet-stream',
    );
    const over = await post(h, '/library/file/master/start', {
      key: KEY,
      name: 'party.psd',
      size: 5,
    });
    expect(over.status).toBe(409);
    expect((await json(over)).error).toMatch(/Rescan/);
    expect(
      (
        await post(h, '/library/file/master/start', {
          key: KEY,
          name: 'party.psd',
          size: 5,
          replace: true,
        })
      ).status,
    ).toBe(200);
    const long = await post(h, '/library/file/master/start', {
      key: KEY,
      name: `${'x'.repeat(300)}.psd`,
      size: 5,
      replace: true,
    });
    expect(long.status).toBe(400);
    const control = await post(h, '/library/file/master/start', {
      key: KEY,
      name: 'bad\u0007name.psd',
      size: 5,
      replace: true,
    });
    expect(control.status).toBe(400);
  });
});

describe('a master on file', () => {
  it('downloads through the library as an attachment, never inline, and audits it', async () => {
    const h = harness({ masters: new FakeSigner() });
    await withMaster(h, 'Party Final.psd', 'the master');
    const res = await h.req(`/library/master?key=${encodeURIComponent(KEY)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Party Final.psd"');
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe('sandbox');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await res.text()).toBe('the master');
    expect((await recentActions(h.db, 1))[0]?.action).toBe('library.master_downloaded');
    expect((await h.req('/library/master?key=media%2Fpsi%2Fnone.jpg')).status).toBe(404);
  });

  it('is removed on its own form, and with the web copy when the box is ticked', async () => {
    const h = harness({ masters: new FakeSigner() });
    const masterKey = await withMaster(h);
    const removed = await h.form('/library/file/master/delete', [
      ['key', KEY],
      ['confirm', 'delete'],
    ]);
    expect(removed.status).toBe(303);
    expect(h.media.objects.has(masterKey)).toBe(false);
    expect(await getAsset(h.db, KEY)).toMatchObject({ master_key: null, master_name: 'party.psd' });
    expect((await recentActions(h.db, 1))[0]).toMatchObject({
      action: 'library.master_deleted',
      actor: STAFF.email,
    });

    await withMaster(h);
    const kept = await h.form('/library/file/delete', [
      ['key', KEY],
      ['confirm', 'delete'],
    ]);
    expect(kept.status).toBe(303);
    expect(h.media.objects.has(KEY)).toBe(false);
    expect(h.media.objects.has(masterKey)).toBe(true); // not ticked: the master stays

    await h.put(KEY, bytes('web2'));
    await h.form('/library/rescan', []); // relinks the orphan to the fresh copy
    expect((await getAsset(h.db, KEY))?.master_key).toBe(masterKey);
    const both = await h.form('/library/file/delete', [
      ['key', KEY],
      ['confirm', 'delete'],
      ['also_master', '1'],
    ]);
    expect(both.status).toBe(303);
    expect(h.media.objects.has(masterKey)).toBe(false);
    expect((await recentActions(h.db, 1))[0]?.detail).toMatchObject({ master: masterKey });
  });

  it('leaves the no-master filter once in the bucket, even without an external link', async () => {
    const h = harness({ masters: new FakeSigner() });
    await withMaster(h);
    await h.put('media/psi/other.jpg', bytes('other'));
    const r = await searchAssets(h.db, { ...ALL, state: 'no-master' }, 10);
    expect(r.assets.map((a) => a.key)).toEqual(['media/psi/other.jpg']);
  });
});

describe('rescan links masters by stem', () => {
  it('links what the bucket holds under masters/, drops links whose object is gone, counts orphans', async () => {
    const h = harness();
    await h.put(KEY, bytes('web'));
    await h.put('media/psi/scan.png', png('scan'));
    await h.media.put('masters/psi/party.ai', bytes('ai'), 'application/octet-stream');
    await h.media.put('masters/psi/scan.tif', bytes('tif'), 'application/octet-stream');
    await h.media.put('masters/psi/orphan.psd', bytes('psd'), 'application/octet-stream');
    const r = await linkMasters(h.db, h.media, h.deps.layout);
    expect(r).toEqual({ masters: 3, linked: 2, unlinked: 0, orphans: 1 });
    expect(await getAsset(h.db, KEY)).toMatchObject({
      master_key: 'masters/psi/party.ai',
      master_name: 'party.ai',
    });
    expect((await getAsset(h.db, 'media/psi/scan.png'))?.master_key).toBe('masters/psi/scan.tif');
    // A second pass changes nothing; a master gone from the bucket is unlinked.
    expect(await linkMasters(h.db, h.media, h.deps.layout)).toEqual({
      masters: 3,
      linked: 0,
      unlinked: 0,
      orphans: 1,
    });
    await h.media.delete('masters/psi/scan.tif');
    expect(await linkMasters(h.db, h.media, h.deps.layout)).toMatchObject({
      masters: 2,
      unlinked: 1,
    });
    expect((await getAsset(h.db, 'media/psi/scan.png'))?.master_key).toBeNull();
    const res = await h.form('/library/rescan', []);
    const flash = decodeURIComponent(res.headers.get('set-cookie')?.split(';')[0] ?? '');
    expect(atob(flash.replace(/^pr_flash=/, ''))).toContain('2 masters (1 without a web copy)');
  });

  it('never lists masters as library files', async () => {
    const h = harness();
    await h.media.put('masters/psi/party.ai', bytes('ai'), 'application/octet-stream');
    await h.form('/library/rescan', []);
    expect(await getAsset(h.db, 'masters/psi/party.ai')).toBeNull();
    const page = await (await h.req('/library?prefix=media/psi/')).text();
    expect(page).not.toContain('party.ai');
  });
});
