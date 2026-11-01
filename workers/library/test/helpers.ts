import { DEFAULT_MENU } from '@photonrelic/media-params';
import { FixedIdentityVerifier, type Identity } from '../src/access.js';
import { createApp } from '../src/app.jsx';
import type { AppDeps } from '../src/deps.js';
import { layoutFromVars, MemoryMediaBucket } from '../src/media.js';
import type { PurgeConfig } from '../src/purge.js';
import { SqliteDb } from './sqlite.js';

export const STAFF: Identity = { email: 'staff@example.com', kind: 'user' };
export const ORIGIN = 'https://media-admin.example.com';

export const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

/** Bytes that sniff as a JPEG or a PNG, distinct per tag, so a Replace passes the format check. */
export const jpeg = (tag: string) =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(tag)]).buffer as ArrayBuffer;
export const png = (tag: string) =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(tag)])
    .buffer as ArrayBuffer;

export async function sha256(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A purge configuration whose API is a fake that records every request and answers as told. */
export function fakePurge(answer: () => Response | Promise<Response> = okPurge) {
  const calls: { url: string; headers: Record<string, string>; files: string[] }[] = [];
  const config: PurgeConfig = {
    zoneId: 'zone123',
    token: 'secret-token',
    fetch: async (url, init) => {
      calls.push({
        url,
        headers: init.headers,
        files: (JSON.parse(init.body) as { files: string[] }).files,
      });
      return answer();
    },
  };
  return { config, calls, urls: () => calls.flatMap((c) => c.files) };
}

export const okPurge = () => Response.json({ success: true, errors: [], result: { id: 'x' } });

export function harness(overrides: Partial<AppDeps> = {}) {
  const db = new SqliteDb();
  const media = new MemoryMediaBucket();
  const deps: AppDeps = {
    db,
    access: new FixedIdentityVerifier(STAFF),
    media,
    layout: layoutFromVars('media/', 'media/, legacy/'),
    mediaOrigin: 'https://img.example.com',
    usage: null,
    menu: DEFAULT_MENU,
    purge: null,
    environment: 'test',
    now: () => new Date('2026-10-30T12:00:00.000Z'),
    ...overrides,
  };
  const app = createApp(deps);
  const req = (path: string, init: RequestInit = {}) =>
    app.request(`${ORIGIN}${path}`, {
      ...init,
      headers: { origin: ORIGIN, ...(init.headers as Record<string, string> | undefined) },
    });
  const form = (path: string, fields: [string, string][]) =>
    req(path, { method: 'POST', body: new URLSearchParams(fields) });
  const put = async (key: string, body: ArrayBuffer, extra: Record<string, string> = {}) =>
    req(`/library/upload/${key}`, {
      method: 'PUT',
      body,
      headers: {
        'content-length': String(body.byteLength),
        'x-sha256': await sha256(body),
        ...extra,
      },
    });
  const replace = async (key: string, body: ArrayBuffer, extra: Record<string, string> = {}) =>
    req(`/library/file/replace?key=${encodeURIComponent(key)}`, {
      method: 'PUT',
      body,
      headers: {
        'content-length': String(body.byteLength),
        'x-sha256': await sha256(body),
        ...extra,
      },
    });
  const replacePrecheck = async (key: string, body: ArrayBuffer) => {
    const res = await req('/library/file/replace/precheck', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, sha256: await sha256(body), size: body.byteLength }),
    });
    return (await res.json()) as { ok: boolean; answer: { status: string; message: string } };
  };
  const precheck = async (entries: { key: string; body: ArrayBuffer }[]) => {
    const res = await req('/library/precheck', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entries: await Promise.all(
          entries.map(async (e) => ({
            key: e.key,
            sha256: await sha256(e.body),
            size: e.body.byteLength,
          })),
        ),
      }),
    });
    return (await res.json()) as {
      ok: boolean;
      answers: { key: string; status: string; existingKey?: string }[];
    };
  };
  return { db, media, deps, app, req, form, put, precheck, replace, replacePrecheck };
}
