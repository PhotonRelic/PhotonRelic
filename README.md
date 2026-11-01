# PhotonRelic

A digital asset manager for images, built entirely on Cloudflare: R2 holds the
files, D1 holds what you know about them, Workers serve the UI, Cloudflare
Images resizes on request, and Cloudflare Access decides who gets in.

It has two Workers. You can use either one on its own.

| Part | What it does |
| --- | --- |
| [`workers/resizer`](workers/resizer) | **Public.** Serves images from an R2 bucket at their own path and resizes them on request from a fixed menu (`?w=`, `?ar=`, `?f=`). Output is cached at the edge. Useful to anyone with images in R2, with or without the library. |
| [`workers/library`](workers/library) | **Private, behind Access.** The media library: browse the bucket, upload a whole shoot from the browser, file images by subject, tags, alt text and credit, find duplicates, retire or delete files. Every write goes into an audit log. |
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
- To limit embedding to your own sites, set `ALLOWED_ORIGINS` to the hosts whose pages may use the images, e.g. `www.example.com, example.com, *.example.com, media-admin.example.com`. A request is judged by its `Origin` header, then its `Referer`; a page on any other host gets a 403, and allowed pages get their own origin back in `Access-Control-Allow-Origin`. `*.example.com` matches subdomains only, so list the bare domain too, and include the library's hostname or its thumbnails stop loading. Requests with neither header (a direct link, an email client, a privacy browser) are let through unless `ALLOW_EMPTY_REFERER = "false"`. This stops other websites hotlinking your images; it does not stop anyone downloading a file and hosting it themselves, since a public image URL has to be fetchable without a login. If you would rather not configure the Worker, a WAF custom rule on the resizer's hostname that blocks requests whose `Referer` is not one of your sites does the same job from the dashboard.

## The library

- **Bucket-first.** The bucket listing is the record of what exists. D1 only holds metadata about keys. Files put in the bucket some other way (the dashboard, `rclone`, another app) appear after a **Rescan** as *unfiled*.
- **Upload.** Drop a folder or files. Each file is hashed in the browser and prechecked before any bytes move, so the library refuses duplicates, names that are already taken, bad names and files over the cap. Files then stream straight into R2, four at a time, under `<UPLOAD_PREFIX><subject>/<name>`. If the tab closes partway, drop the same folder again and only the missing files go up.
- **Nothing is overwritten.** A key that already holds different bytes is refused. The only way to remove an object is the file page's **Delete**, and it needs a ticked confirmation.
- **Filing.** Select tiles and file them in bulk: subject, add or remove tags, credit, and an alt-text pattern using `{name}` and `{subject}`. You see a preview before anything is applied.
- **Duplicates.** Keys with identical bytes (matched by R2 etag or SHA-256) are grouped. Keep one and retire the rest; retired objects keep serving.
- **Access.** The Worker verifies the Cloudflare Access JWT itself on every request, so a misconfigured policy fails closed. Cross-site writes are refused.

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

1. Create the bucket and the database:
   ```sh
   npx wrangler r2 bucket create photonrelic-media
   npx wrangler d1 create photonrelic       # put the id in workers/library/wrangler.toml
   ```
2. **Resizer:** in `workers/resizer/wrangler.toml`, set a route (its own hostname such as `img.example.com`, or a path such as `www.example.com/media/*`), then run `pnpm --filter @photonrelic/resizer deploy`.
3. **Library:** in Cloudflare Zero Trust, create a self-hosted Access application for the library's hostname. In `workers/library/wrangler.toml`, set the route, `ENVIRONMENT = "production"`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` (the application's Audience tag) and `MEDIA_ORIGIN` (the resizer's origin). Then run:
   ```sh
   pnpm --filter @photonrelic/library migrate:remote
   pnpm --filter @photonrelic/library deploy
   ```
   Outside local development the library refuses to start without `ACCESS_AUD`.

Keep the library's `LIBRARY_PREFIXES` and the resizer's `SERVED_PREFIXES` in step, so every file the library lists can also be previewed.

### Configuration

| Worker | Variable | Default | Meaning |
| --- | --- | --- | --- |
| resizer | `SERVED_PREFIXES` | `media/` | Comma-separated key prefixes to serve |
| resizer | `MEDIA_WIDTHS`, `MEDIA_ASPECTS` | the menu above | Comma-separated overrides for the resize menu |
| resizer | `ALLOWED_ORIGINS` | unset (any page) | Comma-separated hosts whose pages may embed images; `*.example.com` for subdomains |
| resizer | `ALLOW_EMPTY_REFERER` | `true` | With `ALLOWED_ORIGINS`: let requests with no `Origin` or `Referer` through |
| library | `UPLOAD_PREFIX` | `media/` | Where uploads go |
| library | `LIBRARY_PREFIXES` | `UPLOAD_PREFIX` | Comma-separated roots the library lists |
| library | `MEDIA_ORIGIN` | unset | The resizer's origin. When unset, previews are streamed whole through the library. |
| library | `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | unset | The Cloudflare Access application |
| library | `ENVIRONMENT` | `local` | Shown as a tag in the header unless it is `production` |

## Design

The UI is server-rendered with [Hono](https://hono.dev) JSX, styled with [Pico CSS](https://picocss.com) plus the PhotonRelic design system in [`app.css`](workers/library/public/static/app.css) (dark only, glass surfaces, glow for elevation, Chakra Petch for text and IBM Plex Mono for every number). [Alpine.js](https://alpinejs.dev) adds the small interactions. There is no build step for the front end.

Third-party components and their licences are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Licence

Copyright 2026 The PhotonRelic Authors. Licensed under the [Apache License, Version 2.0](LICENSE); see [NOTICE](NOTICE). Contributions are accepted under the same licence (section 5 of the licence).
