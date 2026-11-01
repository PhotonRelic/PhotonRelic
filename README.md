# PhotonRelic

[![CI](https://github.com/PhotonRelic/PhotonRelic/actions/workflows/ci.yml/badge.svg)](https://github.com/PhotonRelic/PhotonRelic/actions/workflows/ci.yml)

A digital asset manager for images, built entirely on Cloudflare: R2 holds the
files, D1 holds what you know about them, Workers serve the UI, Cloudflare
Images resizes on request, and Cloudflare Access decides who gets in.

It has two Workers. You can use either one on its own.

| Part | What it does |
| --- | --- |
| [`workers/resizer`](workers/resizer) | **Public.** Serves images from an R2 bucket at their own path and resizes them on request from a fixed menu (`?w=`, `?ar=`, `?f=`). Output is cached at the edge. Useful to anyone with images in R2, with or without the library. |
| [`workers/library`](workers/library) | **Private, behind Access.** The media library: browse the bucket, upload a whole shoot from the browser, file images by subject, tags, alt text, credit and rights, find duplicates, see what is about to expire, retire or delete files. Every write goes into an audit log. |
| [`packages/media-params`](packages/media-params) | The resize menu and URL builder, with no dependencies. Both Workers use it, and so can a site that builds image URLs. |
| [`tools/prep-images.py`](tools/prep-images.py) | Prepares a shoot on your machine before upload: resizes it to fit the resizer's input cap, fixes the names and strips EXIF/GPS. |

## The resizer

```
GET /media/products/chair.jpg                      as stored
GET /media/products/chair.jpg?w=768                768 px wide, scale-down, format from Accept
GET /media/products/chair.jpg?w=320&ar=1:1&f=webp  320 × 320 cover crop, WebP
```

- **Widths:** 160, 320, 480, 768, 1024, 1440 and 2048. **Aspect ratios:** 1:1, 4:3, 3:2, 8:5 and 16:9. **Formats:** `avif`, `webp`, `jpeg` and `auto` (the default, which picks avif, then webp, then jpeg from the `Accept` header).
- Anything off the menu gets a 400. A fixed menu limits how many unique transformations anyone can request, and so limits your Images bill. To change the menu, set `MEDIA_WIDTHS` and `MEDIA_ASPECTS` in `wrangler.toml`.
- Only keys under `SERVED_PREFIXES` with an image extension are served. SVG is never served.
- Resized output is cached at the edge for a day (`s-maxage=86400`). A source over the Images binding's 20 MB input cap, or a deployment without the binding, is served as stored with an `x-media-transform` header saying why.
- By default any site can embed the images: every response carries `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin`.
- Given the library's database (a read-only `DB` binding, commented out in `wrangler.toml`), a key whose rights have expired (the library's **Expires** date has passed) answers `410 Gone` with code `EXPIRED` on a cache miss, before any transform. A copy already at the edge serves out its day; the 410 is not cached, so a new date takes effect at once. Without the binding, expiry only retires the file in the library and the resizer serves it as before.
- With a Workers Analytics Engine binding `USAGE` (`[[analytics_engine_datasets]]`, dataset `photonrelic_usage`), every image served is counted: one data point per 200, indexed by the key, saying whether it went out as stored or resized, in which format, and whether the edge cache answered. Nothing is written for a 4xx or 5xx, and without the binding nothing is written at all. The library reads the dataset back; see [Usage](#usage).
- To limit embedding to your own sites, set `ALLOWED_ORIGINS` to the hosts whose pages may use the images, e.g. `www.example.com, example.com, *.example.com, media-admin.example.com`. A request is judged by its `Origin` header, then its `Referer`; a page on any other host gets a 403, and allowed pages get their own origin back in `Access-Control-Allow-Origin`. `*.example.com` matches subdomains only, so list the bare domain too, and include the library's hostname or its thumbnails stop loading. Requests with neither header (a direct link, an email client, a privacy browser) are let through unless `ALLOW_EMPTY_REFERER = "false"`. This stops other websites hotlinking your images; it does not stop anyone downloading a file and hosting it themselves, since a public image URL has to be fetchable without a login. If you would rather not configure the Worker, a WAF custom rule on the resizer's hostname that blocks requests whose `Referer` is not one of your sites does the same job from the dashboard.

## The library

- **Bucket-first.** The bucket listing is the record of what exists. D1 only holds metadata about keys. Files put in the bucket some other way (the dashboard, `rclone`, another app) appear after a **Rescan** as *unfiled*.
- **Upload.** Drop a folder or files. Each file is hashed in the browser and prechecked before any bytes move, so the library refuses duplicates, names that are already taken, bad names and files over the cap. Files then stream straight into R2, four at a time, under `<UPLOAD_PREFIX><subject>/<name>`. If the tab closes partway, drop the same folder again and only the missing files go up.
- **Nothing is overwritten.** A key that already holds different bytes is refused. The only way to remove an object is the file page's **Delete**, and it needs a ticked confirmation.
- **Filing.** Select tiles and file them in bulk: subject, add or remove tags, credit, licence, expiry, and an alt-text pattern using `{name}` and `{subject}`. You see a preview before anything is applied.
- **Search.** The box in the header, or the Search tab, finds files by any word of their path, subject, tags, default alt text or credit; the last word matches as a prefix, so results appear as you type. Results can be narrowed by subject, by tag and by state (unfiled, filed, retired), each a link beside the results with its count, and filters work with no words at all: *unfiled* with no query is the unfiled queue, *retired* is everything retired. Matches are ranked by relevance (a hit in the subject or tags outranks one in the path); without a query the newest come first. Results are tiles like the Library's, so a page of them can be selected and filed in bulk. The index is an FTS5 table in D1 kept in step by triggers, and only files the library has seen are in it: something put in the bucket some other way is found after a Rescan, which also rebuilds the index.
- **Rights.** A file page records a licence, a source URL (http or https), restrictions, and an expiry date (`YYYY-MM-DD`, the day the rights run out). The audit row for a save lists which fields changed.
- **Expiring.** The Expiring view lists files already expired and files expiring within 30 days, soonest first, each with a Retire button; the Library page shows a count when there are any. Every night at 03:00 UTC a cron run (`[triggers]` in `wrangler.toml`) retires every file whose expiry date has passed, with the note `Expired <date>`, one audit row per file as `system:expiry` and one `library.expiry_run` row for the run; the run touches only files not yet retired, so repeating it changes nothing. **Run expiry now** on the Expiring view does the same at once, and its audit row names who asked. A retired object stays in the bucket; with the resizer's database binding its URL answers 410.
- **Duplicates.** Keys with identical bytes (matched by R2 etag or SHA-256) are grouped. Keep one and retire the rest; retired objects keep serving.
- **Access.** The Worker verifies the Cloudflare Access JWT itself on every request, so a misconfigured policy fails closed. Cross-site writes are refused.
- **Usage.** With the resizer counting (above) and the library configured to read the counts, the file page shows hits over the last 7 and 30 days, Retire and Delete warn when the file was served last month, and **Unused** lists the files nothing has asked for in 90 days.

### Usage

The resizer writes one data point per image served to a Workers Analytics Engine dataset; the library reads
it back through the engine's SQL API. Three things to configure on the library, all optional:

| Variable | What |
| --- | --- |
| `CF_ACCOUNT_ID` | The account id (`provision.sh` fills it in from `CLOUDFLARE_ACCOUNT_ID`) |
| `ANALYTICS_TOKEN` | A secret (`wrangler secret put ANALYTICS_TOKEN`): an API token with the one permission **Account → Account Analytics → Read**. `deploy.sh` puts it from `ANALYTICS_TOKEN` in `.env` when it is set there. The token turns the feature on. |
| `USAGE_DATASET` | The dataset name, default `photonrelic_usage`; must match the resizer's binding |

Two caveats, shown beside the numbers. Analytics Engine samples at high volume (per key, so a busy image is
sampled and a quiet one is not), and the counts are `SUM(_sample_interval)`: estimates, exact while traffic
is modest. And the engine keeps 90 days, so *unused* means not served in the last 90 days, never *never
served*; a file newer than that has had little chance, and a page serving the image from its own cache, or a
copy hosted elsewhere, is not counted. Counts appear within a few minutes of the requests.

**Unused** (`/library/unused`) is the files the library knows and has not retired, minus the keys the engine
saw any hit for in the last 90 days: one grouped query for the keys *with* hits, read in pages of 10,000,
subtracted in the Worker, so a library of thousands of files costs a statement or two. The page is paged a
hundred tiles at a time, oldest first; each tile opens its file page, where Retire and Delete are, and the
selection bar files or tags them as anywhere else.

## Setup

You need Node 22.13 or later, pnpm, and a Cloudflare account with R2, D1 and (for resizing) Images enabled.

```sh
pnpm install
pnpm test
```

### Run locally

The two Workers share one local R2 and D1 state under `.wrangler/state`.

```sh
cp workers/library/.dev.vars.example workers/library/.dev.vars
pnpm --filter @photonrelic/library migrate:local
pnpm --filter @photonrelic/library dev     # http://localhost:8787
pnpm --filter @photonrelic/resizer dev     # http://localhost:8788
```

Locally, Access is skipped: every request is treated as `DEV_IDENTITY` from `.dev.vars`.

### Deploy

A deployment is a directory holding a `library.toml` and a `resizer.toml` (either one is optional) plus two
scripts that read them. `deploy/example/` is the template; everything under `deploy/` except the example is
ignored by git, because the ids and hostnames in it belong to one account. For a team, put the directory in
a private repo with PhotonRelic as a submodule instead, and point `main`, `assets.directory` and
`migrations_dir` at the submodule.

1. Copy the template and edit it: Worker names, the two hostnames (the library's hostname is put behind
   Access; the resizer's is public), the bucket and database names, and `MEDIA_ORIGIN`.
   ```sh
   cp -r deploy/example deploy/production
   ```
2. Put credentials in `.env` (see `.env.example`): a Cloudflare API token with Workers Scripts, Workers R2
   Storage, D1, Access: Apps and Policies, and Access: Organizations, Identity Providers, and Groups
   (account scope) plus Workers Routes and DNS (zone scope); the account id; and the email domains the
   library should let in. Enable R2 in the dashboard once, and Zero Trust if the account has none (the
   script can create the organisation when `ACCESS_TEAM_NAME` is set and Access has been enabled). For
   [usage](#usage), also a second token with Account Analytics Read only, as `ANALYTICS_TOKEN`.
3. Provision. This creates the Access application (allowing the email domains, One-time PIN sign-in), the
   bucket and the database, and writes the team domain, Audience tag and database id into `library.toml`.
   It is idempotent; re-run it after changing the email domains and the policy is updated.
   ```sh
   sh scripts/provision.sh deploy/production
   ```
4. Deploy: migrations, then the resizer, then the library. `--dry-run` builds both Workers without
   credentials.
   ```sh
   sh scripts/deploy.sh deploy/production
   ```

The library refuses to start without `ACCESS_AUD`, so a deployment that skipped provisioning fails closed.
Keep the library's `LIBRARY_PREFIXES` and the resizer's `SERVED_PREFIXES` in step, so every file the library
lists can also be previewed.

### Configuration

| Worker | Variable | Default | Meaning |
| --- | --- | --- | --- |
| resizer | `SERVED_PREFIXES` | `media/` | Comma-separated key prefixes to serve |
| resizer | `MEDIA_WIDTHS`, `MEDIA_ASPECTS` | the menu above | Comma-separated overrides for the resize menu |
| resizer | `ALLOWED_ORIGINS` | unset (any page) | Comma-separated hosts whose pages may embed images; `*.example.com` for subdomains |
| resizer | `ALLOW_EMPTY_REFERER` | `true` | With `ALLOWED_ORIGINS`: let requests with no `Origin` or `Referer` through |
| resizer | `DB` binding | unset | The library's D1 database, read only; with it, expired keys answer 410 |
| library | `UPLOAD_PREFIX` | `media/` | Where uploads go |
| library | `LIBRARY_PREFIXES` | `UPLOAD_PREFIX` | Comma-separated roots the library lists |
| library | `MEDIA_ORIGIN` | unset | The resizer's origin. When unset, previews are streamed whole through the library. |
| library | `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | unset | The Cloudflare Access application |
| library | `CF_ACCOUNT_ID`, `ANALYTICS_TOKEN` (secret), `USAGE_DATASET` | unset, unset, `photonrelic_usage` | Reading the resizer's usage dataset; see [Usage](#usage) |
| library | `ENVIRONMENT` | `local` | Shown as a tag in the header unless it is `production` |

## Design

The UI is server-rendered with [Hono](https://hono.dev) JSX, styled with [Pico CSS](https://picocss.com) plus the PhotonRelic design system in [`app.css`](workers/library/public/static/app.css) (dark only, glass surfaces, glow for elevation, Chakra Petch for text and IBM Plex Mono for every number). [Alpine.js](https://alpinejs.dev) adds the small interactions. There is no build step for the front end.

Third-party components and their licences are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Contributing and security

Bug reports and pull requests are welcome; [CONTRIBUTING.md](CONTRIBUTING.md) has the short version
of how. Please report security problems privately, as described in [SECURITY.md](SECURITY.md).

## Licence

Copyright 2026 The PhotonRelic Authors. Licensed under the [Apache License, Version 2.0](LICENSE); see [NOTICE](NOTICE). Contributions are accepted under the same licence (section 5 of the licence).
