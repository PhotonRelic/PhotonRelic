import { describe, expect, it } from 'vitest';
import { CloudflareAccessVerifier } from '../src/access.js';

const b64url = (b: ArrayBuffer | string) => {
  const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : new Uint8Array(b);
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function makeKeyAndToken(claims: Record<string, unknown>, kid = 'k1') {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  const header = b64url(JSON.stringify({ alg: 'RS256', kid }));
  const payload = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    pair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  const certs = { keys: [{ kid, kty: 'RSA', alg: 'RS256', n: jwk.n, e: jwk.e }] };
  return { token: `${header}.${payload}.${b64url(sig)}`, certs };
}

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'aud-123';
const now = 1_760_000_000_000;

function verifier(certs: unknown, nowMs = now) {
  const fetchImpl = (async () => new Response(JSON.stringify(certs))) as unknown as typeof fetch;
  return new CloudflareAccessVerifier(TEAM, AUD, fetchImpl, () => nowMs);
}

describe('CloudflareAccessVerifier', () => {
  const good = {
    aud: [AUD],
    iss: `https://${TEAM}`,
    exp: now / 1000 + 3600,
    email: 'a@example.com',
  };

  it('accepts a valid token from the header or the cookie', async () => {
    const { token, certs } = await makeKeyAndToken(good);
    const v = verifier(certs);
    expect(
      await v.verify(new Request('https://x', { headers: { 'cf-access-jwt-assertion': token } })),
    ).toEqual({
      email: 'a@example.com',
      kind: 'user',
    });
    expect(
      await v.verify(
        new Request('https://x', { headers: { cookie: `CF_Authorization=${token}` } }),
      ),
    ).toEqual({
      email: 'a@example.com',
      kind: 'user',
    });
  });

  it('reports a service token by its common name', async () => {
    const { token, certs } = await makeKeyAndToken({
      ...good,
      email: undefined,
      common_name: 'automation.access',
    });
    const v = verifier(certs);
    expect(
      await v.verify(new Request('https://x', { headers: { 'cf-access-jwt-assertion': token } })),
    ).toEqual({
      email: 'automation.access',
      kind: 'service',
    });
  });

  it('rejects a wrong audience, issuer, expiry, signature or missing token', async () => {
    const req = (t: string) =>
      new Request('https://x', { headers: { 'cf-access-jwt-assertion': t } });
    const a = await makeKeyAndToken({ ...good, aud: ['other'] });
    expect(await verifier(a.certs).verify(req(a.token))).toBeNull();
    const b = await makeKeyAndToken({ ...good, iss: 'https://evil' });
    expect(await verifier(b.certs).verify(req(b.token))).toBeNull();
    const c = await makeKeyAndToken({ ...good, exp: now / 1000 - 1 });
    expect(await verifier(c.certs).verify(req(c.token))).toBeNull();
    const d = await makeKeyAndToken(good);
    const other = await makeKeyAndToken(good);
    expect(await verifier(other.certs).verify(req(d.token))).toBeNull(); // signed by a different key
    expect(await verifier(d.certs).verify(new Request('https://x'))).toBeNull();
  });
});
