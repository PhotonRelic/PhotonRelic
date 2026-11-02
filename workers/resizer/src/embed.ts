/**
 * Where images may be embedded from. Unset, the resizer is open: any page
 * can use an image URL and CORS is `*`. With ALLOWED_ORIGINS set, a request
 * must come from a page on one of the listed hosts, judged by the Origin
 * header, then the Referer. Anything else is a 403.
 *
 * This stops other websites hotlinking your images. It does not stop anyone
 * downloading a file and hosting it themselves: a public image URL must be
 * fetchable without a login, and a non-browser client can send any Referer.
 */

export interface EmbedPolicy {
  /** Host patterns: `example.com`, `*.example.com` (subdomains only), `localhost:8787`. */
  readonly allowed: readonly string[];
  /** Let through requests with neither Origin nor Referer: direct links, email clients, privacy browsers. */
  readonly allowEmptyReferer: boolean;
}

export type EmbedDecision =
  | { allowed: true; origin: string | null }
  | { allowed: false; reason: 'no-referer' | 'not-allowed' };

const PATTERN = /^(\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/;

/** ALLOWED_ORIGINS as a list of host patterns; undefined or blank means open. */
export function parseAllowedOrigins(raw: string | undefined): string[] | null {
  const list = (raw ?? '')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return null;
  for (const p of list) if (!PATTERN.test(p)) throw new Error(`Not an allowed origin: ${p}`);
  return list;
}

/** ALLOW_EMPTY_REFERER: "false" turns it off; anything else (including unset) leaves it on. */
export function parseAllowEmptyReferer(raw: string | undefined): boolean {
  return (raw ?? 'true').trim().toLowerCase() !== 'false';
}

export function embedPolicyFromVars(
  allowedOrigins: string | undefined,
  allowEmptyReferer: string | undefined,
): EmbedPolicy | null {
  const allowed = parseAllowedOrigins(allowedOrigins);
  return allowed ? { allowed, allowEmptyReferer: parseAllowEmptyReferer(allowEmptyReferer) } : null;
}

/** Does a URL's host match one pattern? A pattern with a port compares host:port; without, the hostname. */
export function hostMatches(url: URL, pattern: string): boolean {
  const hasPort = /:\d+$/.test(pattern);
  const host = hasPort ? url.host : url.hostname;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === pattern;
}

/** The page making the request: `absent` with neither header, `invalid` when a header is present but not a URL. */
export function pageUrl(request: Request): URL | 'absent' | 'invalid' {
  const origin = request.headers.get('origin');
  const header = origin && origin !== 'null' ? origin : request.headers.get('referer');
  if (!header) return 'absent';
  try {
    return new URL(header);
  } catch {
    return 'invalid';
  }
}

/** Decide one request. `origin` is what to echo in Access-Control-Allow-Origin, when known. */
export function decideEmbed(request: Request, policy: EmbedPolicy): EmbedDecision {
  const page = pageUrl(request);
  if (page === 'absent') {
    return policy.allowEmptyReferer
      ? { allowed: true, origin: null }
      : { allowed: false, reason: 'no-referer' };
  }
  if (page === 'invalid') return { allowed: false, reason: 'not-allowed' };
  if (policy.allowed.some((p) => hostMatches(page, p))) {
    return { allowed: true, origin: page.origin };
  }
  return { allowed: false, reason: 'not-allowed' };
}

/** Whether the page making the request is on the given host pattern. */
export function pageIsOn(request: Request, pattern: string): boolean {
  const page = pageUrl(request);
  return page !== 'absent' && page !== 'invalid' && hostMatches(page, pattern);
}

/**
 * LIBRARY_HOST: the library's own host, whose pages may still see a file
 * whose rights have expired. One host pattern; unset or blank means none.
 */
export function libraryHostFromVar(raw: string | undefined): string | null {
  const host = (raw ?? '').trim().toLowerCase();
  if (!host) return null;
  if (!PATTERN.test(host)) throw new Error(`Not a host: ${host}`);
  return host;
}
