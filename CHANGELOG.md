# Changelog

Every release of PhotonRelic, newest first, in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) shape with [Semantic Versioning](https://semver.org/). It is written for the person running a deployment: what changed, what runs when you upgrade, and what you must do yourself. The release workflow publishes a version's section as its release notes, and `upgrade.sh` shows the sections between your pin and the target before it changes anything.

Within a version, **Operators must do** comes first whenever there is something to do; then Added, Changed, Fixed and Security. A major version means a change you must act on; a minor one adds features; a patch fixes things.

## [Unreleased]

## [1.0.0] - 2026-11-09

The first release. Two Workers, one bucket, one database, one login: a public **resizer** that serves and resizes images from a fixed menu, and a private **library** behind Cloudflare Access where staff upload, describe and manage them. It needs a Cloudflare account on Workers Paid with R2, Images and Zero Trust enabled, and a domain whose DNS Cloudflare serves.

### Operators must do

- New deployment: the Quick start in the README runs `install.sh`, or follow `docs/deploy.md` step by step.
- Existing deployment pinned to a commit: `pnpm run upgrade-photonrelic <env>` in the deployment repository moves the pin to this release (`docs/deploy.md`, Upgrading). Older deployment repositories have no wrapper for it yet; run `sh photonrelic/scripts/upgrade.sh environments/<env>` once and the next scaffold has it.
- Migrations 0001 to 0008 run on deploy, in order: all eight on a fresh database, the missing ones on an existing database.
- Commands in a deployment repository are `pnpm run <name>`. pnpm's own `setup` and `deploy` commands shadow the scripts when `run` is left out.

### Added

- **Resizer.** Serves keys under `SERVED_PREFIXES` as stored or resized from a fixed menu of widths (`?w=`), aspect ratios (`?ar=`) and formats (`?f=`), cached at the edge for a day; anything off the menu is a 400. `ALLOWED_ORIGINS` limits embedding to your own pages. With a read-only `DB` binding: cover crops around the library's focal point, `410 Gone` for files whose rights have expired, and the read-only metadata API at `/api/v1/assets`. With a `USAGE` Analytics Engine binding, one data point per image served. `masters/` is refused in code.
- **Library.** A bucket-first media library behind Cloudflare Access, with the Access JWT verified on every request. Browser upload of whole folders, hashed and prechecked, never overwriting; Replace and Delete as deliberate acts on a file page. Filing by subject, tags, alt text, credit, license and expiry, in bulk with a preview. Full-text search over path, subject, tags, alt text, credit, title and creator, with state filters. Capture data and descriptive metadata read from the file or from the prep tool's manifest. Rights fields and a nightly run that retires files whose expiry date has passed. A focal point per file. Duplicates by hash. Copy-ready `<picture>` and `<img srcset>` markup. Masters by link, with the providers' icons, and masters in the bucket under `masters/`, uploaded from the browser on signed URLs. Usage counts and an Unused list when the resizer counts. Cache purge on Replace, Delete and detected changes when `CF_ZONE_ID` and `CACHE_PURGE_TOKEN` are set. An audit log of every write.
- **`@photonrelic/media-params`.** The resize menu, URL builders, `<picture>` markup and the metadata API's types, for sites that build their own image URLs. No dependencies.
- **`tools/prep-images.py`.** Prepares a shoot before upload: fixes names, keeps what a file says about itself, drops what a device recorded about place and identity, writes `photonrelic-manifest.json`, and carries a master found beside a web copy.
- **Deployment.** `init-deploy-repo.sh` creates a private deployment repository with PhotonRelic as a pinned submodule; `preflight.sh` checks the machine, the token, its permissions and the hostnames' zones before anything is created; `provision.sh` creates the Access application, the bucket and its CORS rule, and the database, and writes their ids into the configuration; `deploy.sh` applies migrations and deploys both Workers; `verify.sh` checks the result from the outside; `install.sh` runs all of it from one command; `upgrade.sh` moves a deployment to a newer release. `docs/deploy.md` for people, `AGENTS.md` for an agent doing it for them.
- **Database.** Migrations 0001 to 0008: the asset and audit tables, the search index, focal points, rights, capture data, the search index over capture fields, the license column, and the descriptive fields.

### Security

- The library refuses to start without `ACCESS_AUD`, so a deployment that skipped provisioning fails closed.
- The resizer refuses `masters/` before reading any configuration; masters download only through the library, behind Access.
- Secrets reach the Workers only from the deployment repository's gitignored `.env`, stored by the deploy as Worker secrets.
