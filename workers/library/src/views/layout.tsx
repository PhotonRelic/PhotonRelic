/**
 * The PhotonRelic design system shell. Pico CSS, app.css, the fonts and
 * Alpine come from /static.
 */
import type { Child } from 'hono/jsx';
import type { Identity } from '../access.js';
import type { Flash } from '../flash.js';

export const APP_NAME = 'PhotonRelic';

export const NAV: { href: string; label: string }[] = [
  { href: '/library', label: 'Library' },
  { href: '/library/upload', label: 'Upload' },
  { href: '/audit', label: 'Audit' },
];

export interface PageProps {
  title: string;
  path: string;
  identity: Identity;
  environment: string;
  flashes?: Flash[] | undefined;
  /** ES modules (`<script type="module">`), e.g. the uploader. */
  modules?: string[] | undefined;
  children?: Child | undefined;
}

/** The most specific nav entry the path is under, so Upload is not also Library. */
function activeHref(path: string): string | null {
  const hits = NAV.filter((n) => path === n.href || path.startsWith(`${n.href}/`));
  return hits.sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;
}

export function Layout(props: PageProps) {
  const envTag = props.environment === 'production' ? null : props.environment;
  const active = activeHref(props.path);
  return (
    <html lang="en" data-theme="dark">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>
          {props.title} — {APP_NAME}
        </title>
        <link rel="stylesheet" href="/static/vendor/pico.min.css" />
        <link rel="stylesheet" href="/static/vendor/fonts/fonts.css" />
        <link rel="stylesheet" href="/static/app.css" />
        <script defer src="/static/vendor/alpine.min.js" />
      </head>
      <body>
        <nav class="container-fluid topnav">
          <ul>
            <li>
              <strong>
                <a href="/" class="brand">
                  {APP_NAME}
                </a>
              </strong>
              {envTag ? <mark class="env-tag">{envTag}</mark> : null}
            </li>
          </ul>
          <ul>
            <li>
              <form method="get" action="/library/search" class="nav-search">
                <input
                  type="search"
                  name="q"
                  placeholder="Search"
                  aria-label="Search the library"
                  autocomplete="off"
                />
              </form>
            </li>
            {NAV.map((n) => (
              <li>
                <a href={n.href} class={n.href === active ? 'active' : undefined}>
                  {n.label}
                </a>
              </li>
            ))}
            <li>
              <span
                class="whoami"
                title={props.identity.kind === 'service' ? 'service token' : 'Cloudflare Access'}
              >
                {props.identity.email}
              </span>
            </li>
          </ul>
        </nav>
        <main class="container-fluid">
          {(props.flashes ?? []).map((f) => (
            <article class={`flash flash-${f.level}`}>{f.message}</article>
          ))}
          {props.children}
        </main>
        {(props.modules ?? []).map((s) => (
          <script type="module" src={s} />
        ))}
      </body>
    </html>
  );
}

export const when = (iso: string | null | undefined): string =>
  iso ? iso.replace('T', ' ').slice(0, 16) : '—';

export const kb = (bytes: number): string =>
  bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
