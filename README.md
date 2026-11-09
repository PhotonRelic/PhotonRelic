# PhotonRelic

[![CI](https://github.com/PhotonRelic/PhotonRelic/actions/workflows/ci.yml/badge.svg)](https://github.com/PhotonRelic/PhotonRelic/actions/workflows/ci.yml)

A digital asset manager for images, built entirely on Cloudflare: R2 holds the
files, D1 holds what you know about them, Workers serve the UI, Cloudflare
Images resizes on request, and Cloudflare Access decides who gets in.

## Quick start

Six switches in the Cloudflare dashboard, then one command. [`docs/deploy.md`](docs/deploy.md) explains every step and what comes after; if an AI agent is doing this for you, point it at [`AGENTS.md`](AGENTS.md), the same procedure written for an agent, with what it must ask you for and what it must never do.

1. The account is on the **Workers Paid** plan, with **R2**, **Images** and **Zero Trust** enabled.
2. Your domain is a zone in the account, so the two hostnames (`img.example.com`, `media-admin.example.com`) can be yours.
3. You have an API token with the deploy permissions ([Tokens](docs/deploy.md#tokens)).

```sh
curl -fsSLO https://github.com/PhotonRelic/PhotonRelic/releases/latest/download/install.sh
sh install.sh
```

The installer asks for the two hostnames, your account ID, the email domains staff sign in with and the token (not echoed), then creates a private deployment repository in `./photonrelic-deploy` pinned to the newest [release](https://github.com/PhotonRelic/PhotonRelic/releases), checks the account before creating anything in it, provisions, deploys and verifies. Rather than build the deploy token's permissions by hand, you can hand it one short-lived bootstrap token that may create tokens (`--mint`), and it mints the tokens the deployment needs before the account check, narrows the deploy token to your hostnames' zones, and retires the bootstrap token when done ([Tokens](docs/deploy.md#or-let-the-installer-mint-them)). Each release's notes carry the installer's SHA-256 and the tagged commit, and `--commit` pins an install to that commit. It installs nothing globally on your machine; git, Node 22.13 or later and pnpm 10 or later must be there. Upgrading later is one command in that repository, and nothing changes until you run it. Every release is listed in [`CHANGELOG.md`](CHANGELOG.md) with what an operator must do.

It has two Workers. You can use either one on its own.

| Part | What it does |
| --- | --- |
| [`workers/resizer`](workers/resizer) | **Public.** Serves images from an R2 bucket at their own path and resizes them on request from a fixed menu (`?w=`, `?ar=`, `?f=`). Output is cached at the edge. Useful to anyone with images in R2, with or without the library. Given the library's database, it also answers a read-only [metadata API](#metadata-api) for alt text, dimensions and credit. |
| [`workers/library`](workers/library) | **Private, behind Access.** The media library: browse the bucket, upload a whole shoot from the browser, file images by subject, tags, alt text, credit and rights, find duplicates, see what is about to expire, retire or delete files. Every write goes into an audit log. |
| [`packages/media-params`](packages/media-params) | The resize menu and URL builder, with no dependencies. Both Workers use it, and so can a site that builds image URLs. |
| [`tools/prep-images.py`](tools/prep-images.py) | Prepares a shoot on your machine before upload: fixes the names, keeps what each file says about itself and drops what a device recorded about place and identity (GPS, serial numbers, MakerNote, thumbnails, editing history), re-encoding only what cannot stay as it is. It notes the capture date, camera, lens, original size, title, keywords, creator, credit, copyright and origin in a `photonrelic-manifest.json` beside the copies, recognizes Adobe Stock downloads, and carries a master (`.ai`, `.psd`, a raw file) found beside a web copy. |

## The resizer

```
GET /media/products/chair.jpg                      as stored
GET /media/products/chair.jpg?w=768                768 px wide, scale-down, format from Accept
GET /media/products/chair.jpg?w=320&ar=1:1&f=webp  320 × 320 cover crop, WebP
```

- **Widths:** 160, 320, 480, 768, 1024, 1440 and 2048. **Aspect ratios:** 1:1, 4:3, 3:2, 8:5 and 16:9. **Formats:** `avif`, `webp`, `jpeg` and `auto` (the default, which picks avif, then webp, then jpeg from the `Accept` header).
- Anything off the menu gets a 400. A fixed menu limits how many unique transformations anyone can request, and so limits your Images bill. To change the menu, set `MEDIA_WIDTHS` and `MEDIA_ASPECTS` in `wrangler.toml`.
- Only keys under `SERVED_PREFIXES` with an image extension are served. SVG is never served.
- A cover crop (`?ar=`) is cut around the focal point set in the library when the resizer has the `DB` binding (see the metadata API below); without a point, or without the binding, Cloudflare Images picks the crop (`gravity: auto`). Plain widths are never cropped, so the point does not touch them.
- A cold resize of a large original uses a few hundred milliseconds of CPU in the Worker, which is why the account must be on Workers Paid (see [Setup](#setup)); cache hits use none.
- Resized output is cached at the edge for a day (`s-maxage=86400`). A source over the Images binding's 20 MB input cap, or a deployment without the binding, is served as stored with an `x-media-transform` header saying why.
- By default any site can embed the images: every response carries `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin`.
- Given the library's database (a read-only `DB` binding, commented out in `wrangler.toml`), a key whose rights have expired (the library's **Expires** date has passed) answers `410 Gone` with code `EXPIRED` on a cache miss, before any transform. A copy already at the edge serves out its day; the 410 is not cached, so a new date takes effect at once. Without the binding, expiry only retires the file in the library and the resizer serves it as before. Set `LIBRARY_HOST` to the library's own host and its pages still see the file, so whoever renews or retires it knows what it is; those responses are never written to the shared cache, so a staff view cannot become a public hit. The library is known by its Referer, a publishing control rather than a security boundary: the file was public until its date passed.
- With a Workers Analytics Engine binding `USAGE` (`[[analytics_engine_datasets]]`, dataset `photonrelic_usage`), every image served is counted: one data point per 200, indexed by the key, saying whether it went out as stored or resized, in which format, and whether the edge cache answered. Nothing is written for a 4xx or 5xx, and without the binding nothing is written at all. The library reads the dataset back; see [Usage](#usage).
- To limit embedding to your own sites, set `ALLOWED_ORIGINS` to the hosts whose pages may use the images, e.g. `www.example.com, example.com, *.example.com, media-admin.example.com`. A request is judged by its `Origin` header, then its `Referer`; a page on any other host gets a 403, and allowed pages get their own origin back in `Access-Control-Allow-Origin`. `*.example.com` matches subdomains only, so list the bare domain too, and include the library's hostname or its thumbnails stop loading. Requests with neither header (a direct link, an email client, a privacy browser) are let through unless `ALLOW_EMPTY_REFERER = "false"`, and any page can send none by adding `referrerpolicy="no-referrer"` to its `<img>`, so with the default this stops casual hotlinking, not a site that wants your images. This stops other websites hotlinking your images; it does not stop anyone downloading a file and hosting it themselves, since a public image URL has to be fetchable without a login. If you would rather not configure the Worker, a WAF custom rule on the resizer's hostname that blocks requests whose `Referer` is not one of your sites does the same job from the dashboard.

### Metadata API

A site that embeds images cannot reach the library for alt text, because the library sits behind Access. Give the resizer a read-only `DB` binding to the library's database and it answers for it, as JSON:

```
GET /api/v1/assets/media/products/chair.jpg               one key
GET /api/v1/assets?prefix=media/products/&tag=hero&limit=50   a page, in key order
```

```json
{
  "ok": true,
  "asset": {
    "key": "media/products/chair.jpg",
    "bytes": 412833,
    "contentType": "image/jpeg",
    "width": 2048,
    "height": 1365,
    "subject": "products",
    "tags": ["hero", "oak"],
    "alt": "Oak chair, three-quarter view",
    "credit": "Studio",
    "title": "Oak chair",
    "creator": "A. Photographer",
    "copyright": "© 2026 A. Photographer",
    "origin": "Commissioned shoot",
    "firstSeen": "2026-10-01T09:12:44.000Z",
    "focal": { "x": 0.42, "y": 0.3 }
  }
}
```

`focal` is the point a crop keeps, as fractions of the width and height from the top-left, or `null` when the library left it to the resizer; a site that crops with CSS can hand it to `object-position` as percentages.

- The listing takes `prefix` (must be under `SERVED_PREFIXES`), `subject`, `tag`, `limit` (default 100, at most 500) and `cursor`; it answers `{ ok, assets, cursor }`, and `cursor` is null on the last page. Anything else in the query string is a 400.
- Only what the library filed is served: the hashes, the audit log, who filed what, and where the master is kept stay behind Access. `title`, `creator`, `copyright` and `origin` are what the file said about itself, or what staff typed; null when unknown. A retired key is a 404 here even though it still serves as an image, and a key outside `SERVED_PREFIXES` is a 404 too. Without the binding every call is a 404 with the code `API_UNAVAILABLE`; images are unaffected.
- Answers are cached at the edge for a minute (`s-maxage=60`) and not by browsers, so filing in the library shows up within the minute. Every answer carries `Access-Control-Allow-Origin: *`, whatever `ALLOWED_ORIGINS` says: the embed policy judges pages by their `Referer`, and a build tool sends none.
- [`packages/media-params`](packages/media-params) exports the `AssetRecord`, `AssetResponse` and `AssetListResponse` types and the `assetUrl(origin, key)` and `assetListUrl(origin, opts)` builders, so a site can fetch the metadata with the same package it builds image URLs with.

A site that builds its own markup can use `@photonrelic/media-params` for the URLs and the `<picture>`:

```ts
import { pictureMarkup, imgMarkup, srcset } from '@photonrelic/media-params';

pictureMarkup('https://img.example.com', 'media/products/chair.jpg', {
  widths: [480, 768, 1024, 1440],
  sizes: '(min-width: 60em) 50vw, 100vw',
  alt: 'An oak chair',
  width: 2000, // the stored image's size, for intrinsic width and height
  height: 1500,
});
// <picture>
//   <source type="image/avif" srcset="https://img.example.com/media/products/chair.jpg?w=480&amp;f=avif 480w, …" sizes="…">
//   <source type="image/webp" srcset="…">
//   <img src="…?w=1440&amp;f=jpeg" srcset="…" sizes="…" alt="An oak chair" width="1440" height="1080" loading="lazy" decoding="async">
// </picture>
```

`imgMarkup` makes a plain `<img srcset>` with `f=auto`, and `srcset` just the candidate list. Add `ar: '16:9'` for a cover crop, and pass the resizer's menu (`menuFromLists`) when it is not the default; a width or aspect off the menu throws rather than producing a 400.

## The library

- **Bucket-first.** The bucket listing is the record of what exists. D1 only holds metadata about keys. Files put in the bucket some other way (the dashboard, `rclone`, another app) appear after a **Rescan** as *unfiled*.
- **Upload.** Drop a folder or files. Each file is hashed in the browser and prechecked before any bytes move, so the library refuses duplicates, names that are already taken, bad names and files over the cap. Files then stream straight into R2, four at a time, under `<UPLOAD_PREFIX><subject>/<name>`. If the tab closes partway, drop the same folder again and only the missing files go up.
- **Capture data.** The prep tool notes, before it touches a file, the capture date and time as the camera wrote them, the camera, the lens and the original pixel size. A prepped folder carries them in its `photonrelic-manifest.json`; the uploader reads it, sends each file's entry with the file (an `X-Capture` header of percent-encoded JSON) and never uploads the manifest itself. A file that was not prepped has its own EXIF read in the browser instead, by a small reader of PhotonRelic's own that looks at those tags only (JPEG, PNG and WebP; never GPS or serial numbers). The file page shows what arrived under **Capture**, with the original size against the stored one. The Worker never parses image bytes, so a file that came in some other way and a **Rescan** have no capture data.
- **What the file says about itself.** The prep tool also reads the description and rights fields a file carries in its IPTC, XMP and EXIF (IPTC first, then XMP, then EXIF): the title, the caption, the keywords, the creator, the credit line, the copyright notice, the source, a rights web statement and usage terms. They travel in the manifest entry's `describe` object (an `X-Describe` header on the upload) and seed the record: keywords become tags, the caption the default alt text, the rest the **Title**, **Creator**, **Copyright**, **Origin**, **Credit**, **Source URL** and **Restrictions** fields. Every one is editable, and an upload fills a field only where the record has nothing, so a retry or a second upload of the same key never writes over what staff typed. An unprepped file contributes its EXIF Artist and Copyright the same way. A download named `AdobeStock_<id>` is recognized: its origin is "Adobe Stock <id>", its source URL the asset page, and the prep tool asks once per run which license was bought (`--license` answers for a script). The stored copy keeps those fields in its own metadata too, so a downloaded original still says who made it and who owns it; what is dropped before upload is what a device or an editor recorded about place, identity and your machine: GPS, MakerNote, serial numbers, the owner's name, the EXIF thumbnail, XMP editing history, document IDs and file paths, embedded XMP thumbnails, the creator's contact details, and every Photoshop resource except the IPTC block. Content Credentials are kept as they are; a signature made over the original metadata may no longer validate once that metadata is rewritten.
- **Masters.** The high-resolution or professional-format original a web copy was made from (an `.ai`, `.psd`, `.tif`, a raw file) often lives elsewhere: Drive, SharePoint or OneDrive, S3, Azure Blob, a NAS. A file page records a **Master URL**, any scheme, shown with the provider's own icon (Drive, OneDrive, SharePoint, S3, Azure, Dropbox, Box, each vendored under its brand terms; a lettered chip for anything else), and a **Master file name**, which alone finds the file in any backup. The prep tool fills the name when a master sits beside a web copy with the same name, and copies the master into the output folder untouched; the bulk bar's **Master folder** sets `folder/name` as the link for every selected file whose name is recorded. Search offers a **no master** state for the gap. Nothing about a master leaves the library: the metadata API never serves it.
- **Masters in the bucket.** A master can also live beside its web copy, under `masters/`: `media/psi/party.jpg` has its master at `masters/psi/party.psd`. The resizer refuses `masters/` in code, before any configuration is read, so nothing there is ever public; downloads come back through the library, behind Access, as attachments. The bytes go straight from the browser into the bucket on a signed URL (one PUT up to 100 MB, a multipart upload in 100 MB parts above it, up to 5 GiB), and the library starts, completes and audits the upload itself: on completion it checks the object's size against what the browser declared before linking it. One master per web copy; a second is refused unless **Replace** is ticked. The file page's **Master in the bucket** section uploads, downloads and removes one; a folder dropped on Upload with `party.psd` beside `party.jpg` sends the master after the web copy; **Delete** offers to take the master with the web copy; a **Rescan** lists `masters/`, links each to the web copy with the same stem, drops links whose object is gone and counts masters with no web copy. It needs an R2 API token (below); without one the file page says masters are not configured and the external link still works.
- **Uploads never overwrite.** A key that already holds different bytes is refused at upload. The two ways to change an object in place are both on its file page, each a person's deliberate act: **Replace** and **Delete**, which needs a ticked confirmation.
- **Replace.** New bytes under the same key, for a reshoot or a re-edit that every page already links to. The file must have the key's own extension and be under the cap; the browser hashes it and asks first, so the same bytes again are refused as a no-op. The library checks the hash and the format (a PNG cannot go under a `.jpg` key) before it writes. The subject, tags, alt text, credit and retired state stay; the etag, hash, size and dimensions are replaced, and the audit log records the old and new hash. When a cache purge is configured (below), every copy the edge holds is purged at once; otherwise the edge keeps serving the old image for up to a day. Browsers that already have a copy may keep it for up to an hour, because the resizer sends `max-age=3600`.
- **Cache purge.** With `CF_ZONE_ID` and the `CACHE_PURGE_TOKEN` secret set, a Replace, a Delete, and a Rescan that finds a key's bytes changed outside the library (`rclone`, the dashboard) purge the stored URL and every size on the resizer's menu from the edge, so the change shows within a minute. The library must know the resizer's menu: set `MEDIA_WIDTHS` and `MEDIA_ASPECTS` on the library too if the resizer overrides them. A purge that fails is a line in the audit log and in the flash, never an error; the write has already happened.
- **Filing.** Select tiles and file them in bulk: subject, add or remove tags, credit, license, expiry, and an alt-text pattern using `{name}` and `{subject}`. You see a preview before anything is applied.
- **Search.** The box in the header, or the Search tab, finds files by any word of their path, subject, tags, default alt text, credit, title or creator, so a creator's name finds every file by them; the last word matches as a prefix, so results appear as you type. Results can be narrowed by subject, by tag and by state (unfiled, filed, retired, no master), each a link beside the results with its count, and filters work with no words at all: *unfiled* with no query is the unfiled queue, *retired* is everything retired. Matches are ranked by relevance (a hit in the subject, tags or title outranks one in the path); without a query the newest come first. Results are tiles like the Library's, so a page of them can be selected and filed in bulk. The index is an FTS5 table in D1 kept in step by triggers, and only files the library has seen are in it: something put in the bucket some other way is found after a Rescan, which also rebuilds the index.
- **Rights.** A file page records the creator, the copyright notice, the origin ("Adobe Stock 270140535", a commissioned shoot), a license, a source URL (http or https), restrictions, and an expiry date (`YYYY-MM-DD`, the day the rights run out). The bulk bar sets the creator and license across a selection. The audit row for a save lists which fields changed.
- **Expiring.** The Expiring view lists files already expired and files expiring within 30 days, soonest first, each with a Retire button; the Library page shows a count when there are any. Every night at 03:00 UTC a cron run (`[triggers]` in `wrangler.toml`) retires every file whose expiry date has passed, with the note `Expired <date>`, one audit row per file as `system:expiry` and one `library.expiry_run` row for the run; the run touches only files not yet retired, so repeating it changes nothing. **Run expiry now** on the Expiring view does the same at once, and its audit row names who asked. A retired object stays in the bucket; with the resizer's database binding its URL answers 410.
- **Focal point.** On a file's page, click the part of the image a crop must keep (a face, a label, the product) and save. Every `?ar=` size the resizer cuts from then on is cropped around that point, and the metadata API carries it so a site cropping with CSS can set `object-position` itself; plain widths are never cropped. **Automatic** clears it and the resizer chooses again. Saving purges the key's cached sizes when a purge is configured (below); otherwise the old crops refresh within a day. Retired files are left alone.
- **Duplicates.** Keys with identical bytes (matched by R2 etag or SHA-256) are grouped. Keep one and retire the rest; retired objects keep serving.
- **Markup.** The file page offers copy-ready embed markup: tick the widths, choose an aspect and `sizes`, and copy a `<picture>` with avif and webp sources and a jpeg fallback, or a plain `<img srcset>`. The alt text is the file's default alt text, and every width and aspect comes from the resizer's menu. It needs `MEDIA_ORIGIN`; if the resizer's menu is not the default, set the library's `MEDIA_WIDTHS` and `MEDIA_ASPECTS` to the same lists.
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

You need Node 22.13 or later, pnpm, and a Cloudflare account on the **Workers Paid** plan with R2, D1 and (for resizing) Images enabled.

Workers Paid is not optional for the resizer. A cold resize of a 10 MB original costs a few hundred milliseconds of CPU inside the Worker, and the Free plan allows 10 ms per request: one thumbnail at a time rides the runtime's allowance for occasional overruns, but a page of twenty new thumbnails asks for twenty at once and most are killed with `Worker exceeded CPU time limit` (error 1102) before the binding answers. On Workers Paid the default is 30 seconds per request and the same page loads in a few seconds. After changing the plan, deploy the resizer again: a running version keeps the limit it was deployed with.

Masters in the bucket need one more credential: an R2 API token with **Object Read & Write** on the one media bucket, created under R2 → Manage API tokens, no expiry. Its two halves go into `.env` as `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` (see `.env.example`); `deploy.sh` stores them as the library Worker's secrets, `provision.sh` sets the bucket's CORS rule for the library's origin (method PUT, header `content-type`, exposed header `ETag`), and `library.toml` names the bucket in `MEDIA_BUCKET`. The browser's part uploads carry a signed URL good for fifteen minutes, bound to one key and one method, instead of the Access cookie: a second door beside Access, which is why the token is scoped to the bucket and nothing else.

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

A deployment is a directory holding a `library.toml` and a `resizer.toml` (either one is optional) built from
the template in `deploy/example/`, plus the scripts in `scripts/` that read them. Everything under `deploy/`
except the example is ignored by git, because the ids and hostnames in it belong to one account; the
intended home for them is a private repository with PhotonRelic as a submodule pinned to a release, which
`scripts/init-deploy-repo.sh` creates and `scripts/install.sh` ([Quick start](#quick-start)) drives from one
command. The scripts, in the order they are run:

| Script | Does |
| --- | --- |
| `install.sh [options]` | All of the below from one command, asking for what it needs; every answer has a flag. Attached to every release. |
| `init-deploy-repo.sh <dir> --name <env> --library-host <h> --resizer-host <h> [--source <url>] [--ref <tag>]` | Creates the private deployment repository: submodule at the newest release, filled-in configuration, wrappers, README. |
| `mint-tokens.sh deploy/<env> --deploy [--usage] [--purge] [--masters]` | With one bootstrap token in `CLOUDFLARE_BOOTSTRAP_TOKEN`, creates the deployment's tokens through the API, each named and scoped to one job, into `.env`. |
| `preflight.sh deploy/<env>` | Checks the machine, the token's permissions, R2, Zero Trust, the hostnames' zones and the optional tokens. Creates nothing. |
| `provision.sh deploy/<env>` | Creates the Access application, the bucket and its CORS rule, and the database; writes their ids into the configuration. Idempotent. |
| `deploy.sh deploy/<env> [--dry-run]` | Applies migrations, deploys the resizer, then the library; stores the optional tokens from `.env` as secrets. |
| `verify.sh deploy/<env> [--key <key>]` | Checks the deployed result from the outside: the resizer, the metadata API, the Access login, migrations, CORS, and with a key, resizing. |
| `upgrade.sh deploy/<env> [vX.Y.Z]` | In a deployment repository: shows the changelog between the pin and the target, moves the pin, deploys, verifies, commits. |

Credentials come from `.env` in the directory the scripts run from (see `.env.example`). The full walk-through,
with the token permissions, the optional features, upgrading, a second environment and troubleshooting, is
[`docs/deploy.md`](docs/deploy.md). Releases are tags `vX.Y.Z` with notes from [`CHANGELOG.md`](CHANGELOG.md);
a deployment pins one and moves only when its operator runs the upgrade.

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
| resizer | `LIBRARY_HOST` | unset | The library's host; its pages may still see a file whose rights have expired (uncached) |
| resizer | `DB` (binding) | unset | The library's D1 database, read only; turns on the metadata API, and a key whose rights have expired answers 410 |
| library | `UPLOAD_PREFIX` | `media/` | Where uploads go |
| library | `LIBRARY_PREFIXES` | `UPLOAD_PREFIX` | Comma-separated roots the library lists |
| library | `MEDIA_ORIGIN` | unset | The resizer's origin. When unset, previews are streamed whole through the library. |
| library | `MEDIA_WIDTHS`, `MEDIA_ASPECTS` | the menu above | The resizer's menu, for embed markup and so a purge covers every size the edge may hold; must match the resizer's. Unset keeps the default menu. |
| library | `CF_ZONE_ID` | unset | The zone the resizer's hostname is in. With the token, turns the cache purge on. |
| library | `CACHE_PURGE_TOKEN` | unset | Secret (`wrangler secret put`): an API token with Zone → Cache Purge → Purge on that zone |
| library | `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | unset | The Cloudflare Access application |
| library | `CF_ACCOUNT_ID`, `ANALYTICS_TOKEN` (secret), `USAGE_DATASET` | unset, unset, `photonrelic_usage` | Reading the resizer's usage dataset; see [Usage](#usage) |
| library | `MEDIA_BUCKET`, `R2_ACCESS_KEY_ID` (secret), `R2_SECRET_ACCESS_KEY` (secret) | unset | Masters in the bucket: the bucket's name and an R2 API token with Object Read & Write on it; needs `CF_ACCOUNT_ID` too. Unset, the file page says masters are not configured. |
| library | `ENVIRONMENT` | `local` | Shown as a tag in the header unless it is `production` |

## Design

The UI is server-rendered with [Hono](https://hono.dev) JSX, styled with [Pico CSS](https://picocss.com) plus the PhotonRelic design system in [`app.css`](workers/library/public/static/app.css) (dark only, glass surfaces, glow for elevation, Chakra Petch for text and IBM Plex Mono for every number). [Alpine.js](https://alpinejs.dev) adds the small interactions. There is no build step for the front end.

Third-party components and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the Workers' npm dependencies are Hono and, for signing master uploads, aws4fetch (both MIT).

## Contributing and security

Bug reports and pull requests are welcome; [CONTRIBUTING.md](CONTRIBUTING.md) has the short version
of how. Please report security problems privately, as described in [SECURITY.md](SECURITY.md).

## License

Copyright 2026 The PhotonRelic Authors. Licensed under the [Apache License, Version 2.0](LICENSE); see [NOTICE](NOTICE). Contributions are accepted under the same license (section 5 of the license).
