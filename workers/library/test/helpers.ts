import { FixedIdentityVerifier, type Identity } from '../src/access.js';
import { createApp } from '../src/app.jsx';
import type { AppDeps } from '../src/deps.js';
import { layoutFromVars, MemoryMediaBucket } from '../src/media.js';
import { SqliteDb } from './sqlite.js';

export const STAFF: Identity = { email: 'staff@example.com', kind: 'user' };
export const ORIGIN = 'https://media-admin.example.com';

export const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

export async function sha256(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function harness(overrides: Partial<AppDeps> = {}) {
  const db = new SqliteDb();
  const media = new MemoryMediaBucket();
  const deps: AppDeps = {
    db,
    access: new FixedIdentityVerifier(STAFF),
    media,
    layout: layoutFromVars('media/', 'media/, legacy/'),
    mediaOrigin: 'https://img.example.com',
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
  return { db, media, deps, app, req, form, put, precheck };
}
