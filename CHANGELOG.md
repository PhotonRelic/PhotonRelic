# Changelog

Every release of PhotonRelic, newest first, in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) shape with [Semantic Versioning](https://semver.org/). It is written for the person running a deployment: what changed, what runs when you upgrade, and what you must do yourself. The release workflow publishes a version's section as its release notes, and `upgrade.sh` shows the sections between your pin and the target before it changes anything.

Within a version, **Operators must do** comes first whenever there is something to do; then Added, Changed, Fixed and Security. A major version means a change you must act on; a minor one adds features; a patch fixes things.

## [Unreleased]

### Operators must do

- Migration 0009 runs on deploy: two small tables, for master uploads in flight and for the library's own locks. Nothing to configure.
- Local development now needs `DEV_IDENTITY` in `workers/library/.dev.vars` (copy `.dev.vars.example`); the library no longer runs without Access on the strength of `ENVIRONMENT = "local"` alone.
- pnpm 10 or later is now required on the machine that deploys (`npm install -g pnpm@12`). It enforces the list of dependencies allowed to run install scripts, which pnpm 9 did not.
- `.env` must be readable by you alone; preflight fails otherwise. `chmod 600 .env` fixes an existing file.
- A deploy token minted by an earlier version of `mint-tokens.sh` may still cover every zone in the account. Run `mint-tokens.sh environments/<env> --deploy` once: it reads the token's scope and tells you if it must be replaced.

### Added

- `scripts/mint-tokens.sh`: creates the deployment's API tokens from one bootstrap token (Account API Tokens Edit, nothing else), each named `photonrelic-<env>-<purpose>` and scoped to one job: the deploy token, and optionally the usage token, the cache purge token (with `CF_ZONE_ID` set) and the R2 key pair for masters on the one bucket. Written to `.env`, never printed. `--retire-bootstrap` deletes the bootstrap token afterwards; without it, both scripts end by saying the bootstrap token is still valid and how to delete it.
- `install.sh` uses it when `CLOUDFLARE_BOOTSTRAP_TOKEN` is in the environment: `--usage`, `--purge`, `--masters` and `--retire-bootstrap` make a whole installation, tokens included, one command. `AGENTS.md` and `docs/deploy.md` describe the path and what the bootstrap token is.
- `install.sh --mint` asks for the bootstrap token at a hidden prompt, so it never has to be in the environment or the shell history. Only an account-owned bootstrap token (Manage Account → Account API Tokens) is accepted: it can retire itself, and the tokens it mints belong to the account. A user-owned one is deleted on the spot when the token allows that, and the run stops asking for an account-owned one. `--commit <sha>` makes the installer, and `init-deploy-repo.sh`, refuse a checkout that is not that exact commit; each release's notes now end with the tagged commit and the installer's SHA-256.
- Release tags must be signed by a key listed in `.github/allowed_signers`; the release workflow verifies the signature, and never replaces a published `install.sh`.
- `pnpm-workspace.yaml` sets `minimumReleaseAge` to one day, so a dependency version must have been public for a day before pnpm installs it.

### Fixed

- `mint-tokens.sh` narrows the deploy token to the hostnames' zones before writing it to `.env`; if the zones cannot be found or the narrowing fails, the new token is deleted and nothing is written. Before, a token with DNS and Workers Routes on every zone in the account could be left in `.env` with only a note. On a re-run it reads the existing token's scope and refuses to continue with one that is still account-wide.
- The scripts no longer export the contents of `.env` into every process they run. The file is read line by line, never executed, and only wrangler receives the deploy token and account ID. The bootstrap token is removed from the environment at once and handed only to the minting steps.
- API tokens travel to curl on its standard input, not its command line, so they do not appear in the process list on shared machines.
- `provision.sh` validates the email domains, the team name, the environment name, the hostname and the bucket and database names before building API requests, and escapes values returned by the API before writing them into the TOML files. `install.sh` and `init-deploy-repo.sh` accept only well-formed hostnames and only `https://`, `ssh://`, `git@host:` or local sources.
- `deploy.sh` and preflight refuse a `library.toml` that sets `ENVIRONMENT = "local"` or has no `ACCESS_AUD` line, the two configurations that would deploy the library without a login. `deploy.sh` rejects any option other than `--dry-run` instead of treating a typo as a real deploy.
- `upgrade.sh` strips escape characters from the changelog it shows and fetches only from `https://`, `ssh://`, `git@host:` or local remotes.

### Fixed

- Completing a master upload acts only on an upload this library started: a completion whose declared size does not match removes the half-upload it created, writes an audit row (`library.master_removed`), and never touches a master already on file. Aborting a multipart upload needs the upload's own id and is audited (`library.master_aborted`). A plain master upload no longer writes over an unlinked object already at the master's key; Replace does.
- The upload path verifies the bytes before storing them, as Replace already did: the declared SHA-256 must match, and the file must be the format its name says (a PNG under a `.jpg` key, or a file that is not a web image, is refused with 415). Two uploads racing for one new key cannot both win; the bucket write is conditional on the key being free.
- A retry that finds its object already stored completes the record without rewriting what the first upload recorded: dimensions, uploader and capture data are kept, and only empty fields are filled.
- The library's security headers are on every response, including the 401, the 404 page and the error page; an error before sign-in says nothing about its cause. `Permissions-Policy` and `Cross-Origin-Opener-Policy` are set.
- Master links keep to an allowlist of schemes (web, cloud stores, network shares); a `javascript:` or `data:` link is refused when saved.
- The raw preview serves the content type the key's extension implies, inline and sandboxed, whatever type the object was stored with.
- A Rescan takes a lock, so two cannot walk the bucket and rebuild the search index at once; a lock older than fifteen minutes is taken over. A search page number is bounded.
- Resizer: the edge cache key is now built from the key and the parsed parameters, not from the request URL, so every accepted spelling of a request lands on one cache entry and the library's purge after a Replace, Delete or focal-point change covers everything the edge may hold. Alongside it, the resizer is stricter about spellings: a width must be written as it appears on the menu (`w=320`, not `w=0320` or `w=3.2e2`) and a parameter given twice is a 400. Before, each such spelling was a cache miss that ran a fresh transform, which the fixed menu was meant to rule out.
- Resizer: `SERVED_PREFIXES` refuses `masters/`, `api/` and `healthz/`, and the metadata API's listing never includes `masters/` whatever the configuration says.
- Resizer: a served object's `Content-Type` comes from the key's extension unless the stored type is an image type other than SVG, so a non-image body written under an image key by other means is never served as a document.
- Resizer: the metadata API no longer describes a key whose rights have expired, so it agrees with the image's 410 before the nightly run retires the row; a `prefix` parameter is validated like a key, and the error for a bad prefix no longer lists the configured prefixes.

### Security

- The library's no-Access mode exists only for local development: it requires `DEV_IDENTITY` (from `.dev.vars`, which is never deployed) and answers on localhost only. A deployed configuration without `ACCESS_AUD` has no door at all, whatever `ENVIRONMENT` says.
- A malformed Access token is refused rather than reported: the signature is decoded inside the same guard as the header and claims.

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

### Fixed

- `verify.sh` no longer reports "nothing answered" when only the machine's own resolver is behind: a hostname checked before its DNS record existed is cached as missing for up to half an hour, so the checks now resolve through 1.1.1.1 and say so. A hostname that resolves nowhere, and a hostname that resolves but does not answer, get their own messages.

### Security

- The library refuses to start without `ACCESS_AUD`, so a deployment that skipped provisioning fails closed.
- The resizer refuses `masters/` before reading any configuration; masters download only through the library, behind Access.
- Secrets reach the Workers only from the deployment repository's gitignored `.env`, stored by the deploy as Worker secrets.
