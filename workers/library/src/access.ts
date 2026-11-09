/**
 * Cloudflare Access identity. Access sits in front of the hostname and sets
 * `Cf-Access-Jwt-Assertion` (also the CF_Authorization cookie). The Worker
 * verifies the token itself, against the team's public keys and the
 * application's AUD, so a misconfigured Access policy fails closed. The
 * verified email is the audit log's actor.
 */

export interface Identity {
  email: string;
  /** A person signed in through an identity provider, or a service token. */
  kind: 'user' | 'service';
}

export interface AccessVerifier {
  verify(request: Request): Promise<Identity | null>;
}

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

interface Claims {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  email?: string;
  common_name?: string;
}

const decoder = new TextDecoder();

function b64urlToBytes(s: string): Uint8Array {
  const b = atob(
    s
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(s.length / 4) * 4, '='),
  );
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

function tokenFrom(request: Request): string | null {
  const header = request.headers.get('cf-access-jwt-assertion');
  if (header) return header;
  const cookie = request.headers.get('cookie') ?? '';
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return m?.[1] ?? null;
}

export class CloudflareAccessVerifier implements AccessVerifier {
  private keys = new Map<string, CryptoKey>();
  private fetchedAt = 0;

  constructor(
    private readonly teamDomain: string,
    private readonly aud: string,
    // Wrapped: a bare `fetch` called as a method has the wrong `this` in workerd.
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async loadKeys(): Promise<void> {
    const res = await this.fetchImpl(`https://${this.teamDomain}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`Access certs responded ${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    const next = new Map<string, CryptoKey>();
    for (const jwk of body.keys ?? []) {
      if (jwk.kty !== 'RSA') continue;
      next.set(
        jwk.kid,
        await crypto.subtle.importKey(
          'jwk',
          { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify'],
        ),
      );
    }
    this.keys = next;
    this.fetchedAt = this.now();
  }

  private async key(kid: string): Promise<CryptoKey | null> {
    const stale = this.now() - this.fetchedAt > 60 * 60 * 1000;
    if (stale || !this.keys.has(kid)) await this.loadKeys();
    return this.keys.get(kid) ?? null;
  }

  async verify(request: Request): Promise<Identity | null> {
    const token = tokenFrom(request);
    if (!token) return null;
    const [h, p, s, extra] = token.split('.');
    if (!h || !p || !s || extra !== undefined) return null;
    let header: { alg?: string; kid?: string };
    let claims: Claims;
    let signature: Uint8Array;
    try {
      header = JSON.parse(decoder.decode(b64urlToBytes(h)));
      claims = JSON.parse(decoder.decode(b64urlToBytes(p)));
      signature = b64urlToBytes(s);
    } catch {
      // Not a token at all; a malformed one is refused, not reported.
      return null;
    }
    if (header.alg !== 'RS256' || !header.kid) return null;
    const key = await this.key(header.kid);
    if (!key) return null;
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      signature,
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!ok) return null;
    const nowS = Math.floor(this.now() / 1000);
    if (claims.iss !== `https://${this.teamDomain}`) return null;
    const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
    if (!aud.includes(this.aud)) return null;
    if (typeof claims.exp !== 'number' || claims.exp <= nowS) return null;
    if (typeof claims.nbf === 'number' && claims.nbf > nowS + 60) return null;
    if (claims.email) return { email: claims.email, kind: 'user' };
    if (claims.common_name) return { email: claims.common_name, kind: 'service' };
    return null;
  }
}

/** Local development and tests: every request is this identity. */
export class FixedIdentityVerifier implements AccessVerifier {
  constructor(private readonly identity: Identity) {}
  async verify(): Promise<Identity> {
    return this.identity;
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The identity local development runs as, and nothing else: a request that
 * does not arrive at localhost gets no identity at all, so a configuration
 * that left Access off cannot be served from a public hostname. `wrangler dev`
 * answers on localhost; a deployed Worker never does.
 */
export class LocalhostVerifier implements AccessVerifier {
  constructor(private readonly identity: Identity) {}
  async verify(request: Request): Promise<Identity | null> {
    return LOCAL_HOSTS.has(new URL(request.url).hostname) ? this.identity : null;
  }
}
