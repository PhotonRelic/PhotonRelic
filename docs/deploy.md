# Deploying PhotonRelic

This guide takes you from a Cloudflare account to a working library and image origin, with nothing assumed beyond knowing your way around a terminal. It is written for a person; an agent working for you follows the same steps through [`AGENTS.md`](../AGENTS.md). Every command here is run as written; nothing is paraphrased.

## What you are deploying

Two Workers, one bucket, one database, one login:

| Piece | What it is | Who reaches it |
| --- | --- | --- |
| The **resizer** | A Worker at a public hostname such as `img.example.com`. Serves every image at a stable URL, resized on request from a fixed menu, cached at the edge. Also the read-only metadata API. | Anyone, or only pages on your own sites if you say so. |
| The **library** | A Worker at a private hostname such as `media-admin.example.com`. The staff app: upload, file, describe, manage rights, see usage. | Staff who sign in through Cloudflare Access. |
| The **bucket** (R2) | The files. Web copies under `media/`, masters under `masters/`, which the resizer never serves. | The two Workers. |
| The **database** (D1) | Everything the library knows about a file, and the audit log. The resizer reads it for the metadata API and expiry. | The two Workers. |
| **Access** (Zero Trust) | The login in front of the library. Staff sign in with a one-time PIN sent to an address on a domain you allow. | Staff. |

Each environment (production, staging) is its own set of all five and shares nothing with any other.

## Prerequisites

Do these once in the Cloudflare dashboard. Each is a product switch, not a configuration task.

| Need | Where | Why |
| --- | --- | --- |
| A Cloudflare account | dash.cloudflare.com | Everything lives in it. The **account ID** is on the right of the account's home page; you will need it. |
| Your domain as a zone | Websites → Add a domain | Both hostnames must be under a domain whose DNS Cloudflare serves. The Free zone plan is enough. |
| **Workers Paid** plan | Workers & Pages → Plans | Required. A cold resize of a large original takes a few hundred milliseconds of CPU; the Free plan's 10 ms limit kills a page of fresh thumbnails. Base price is $5 a month. |
| **R2** enabled | R2 → Overview → Get started | Object storage. Needs a payment method on the account; usage at library scale sits inside the free allowance. |
| **Images** enabled | Images → Overview | The transformations the resizer uses. Without it every image is served as stored and the resizer says so in a header. |
| **Zero Trust** enabled | Zero Trust → choose the Free plan | Access is part of Zero Trust. You pick a team name, which becomes `<team>.cloudflareaccess.com`, the login page's address. The provisioning script can create this for you if you prefer (`ACCESS_TEAM_NAME`). |

On your machine: Node 22.13 or later, pnpm (run `corepack enable`; it picks the version the project names), git, and curl.

## Where your copy of the code lives

The deployment repository you are about to create points at PhotonRelic as a git submodule. Decide which repository that is:

- **The public project** (`https://github.com/PhotonRelic/PhotonRelic.git`). Simplest. Nothing to maintain. Right when you will not change the code and are content to track the project.
- **Your GitHub fork.** Recommended for a team that might change anything. Fork on GitHub, point the submodule at the fork, and keep it current with GitHub's **Sync fork** button or `git fetch upstream && git merge --ff-only upstream/master`. Changes you make go on a branch in the fork and come back to the project as a pull request. A fork of a public repository is public by GitHub's rules; that is fine, because your deployment configuration never goes in it.
- **A private mirror.** Only when your organization forbids public repositories. Create an empty private repository, push the project's `master` into it, never commit to it, and fast-forward it from the project when you upgrade. Nothing flows back to the project except by hand; that is the price of the rule.

Whichever you choose, the deployment repository itself is **private**: the ids and hostnames the provisioning script writes into it belong to your account.

## Create the deployment repository

From a checkout of PhotonRelic (the project, your fork or your mirror):

```sh
sh scripts/init-deploy-repo.sh ../my-photonrelic-deploy \
  --name production \
  --library-host media-admin.example.com \
  --resizer-host img.example.com
```

Add `--source <git url>` for a fork or mirror; the default is the public project. The result is a new git repository, staged and not committed, holding:

```
photonrelic/                       PhotonRelic as a submodule, pinned to a commit
environments/production/library.toml   the library Worker's configuration, names filled in
environments/production/resizer.toml   the resizer Worker's configuration
scripts/{preflight,provision,deploy,verify}.sh   wrappers that call PhotonRelic's scripts
package.json                       pnpm setup / check / preflight / provision / deploy / verify
.env.example                       the credentials file to copy
README.md                          these steps, for this repository
```

Read the two TOML files once. The hostnames, Worker names, bucket name and database name are filled in from `--name` and the hosts. The `REPLACE_` values are filled in by provisioning. In `resizer.toml`, uncomment `ALLOWED_ORIGINS` and list your websites if only your own pages may embed images; uncomment `LIBRARY_HOST` so the library's pages can still show a file whose rights have expired.

Then:

```sh
cd ../my-photonrelic-deploy
git commit -m "PhotonRelic deployment repository"
pnpm install && pnpm setup
```

Create a private repository on GitHub for it and push, when you are ready. Nothing secret is in it; it is private because it is yours.

## Tokens

Tokens are created at **My Profile → API Tokens → Create Token → Create Custom Token**, or under the account's **Manage Account → Account API Tokens**. Copy each one into `.env` as you make it; the dashboard shows a token once.

```sh
cp .env.example .env
```

**The deploy token** (`CLOUDFLARE_API_TOKEN`), one token with these permissions and nothing more:

| Scope | Permission | Used for |
| --- | --- | --- |
| Account | Workers Scripts → Edit | deploying the two Workers |
| Account | Workers R2 Storage → Edit | the bucket and its CORS rule |
| Account | D1 → Edit | the database and migrations |
| Account | Access: Apps and Policies → Edit | the login in front of the library |
| Account | Access: Organizations, Identity Providers, and Groups → Edit | the one-time PIN provider, and the organization if you let the script create it |
| Zone (your domain) | Workers Routes → Edit | the two custom domains |
| Zone (your domain) | DNS → Edit | the DNS records the custom domains need |

Set **Account Resources** to your one account and **Zone Resources** to the one zone. Leave the IP filter and the expiry as you like; an expired token fails preflight with a clear message.

Also in `.env`: `CLOUDFLARE_ACCOUNT_ID`, and `ACCESS_ALLOWED_EMAIL_DOMAINS`, the comma-separated email domains staff sign in with (`example.com`). If the account has no Zero Trust organization yet and you want the script to create one, set `ACCESS_TEAM_NAME`.

**Optional tokens**, each turning on one feature. Skip them now; add them later and run `pnpm deploy` again.

| Variable | Token | Feature |
| --- | --- | --- |
| `ANALYTICS_TOKEN` | Account → Account Analytics → Read | Usage counts per file and the "unused in 90 days" list. |
| `CACHE_PURGE_TOKEN` | Zone → Cache Purge → Purge, on the resizer's zone. Also uncomment `CF_ZONE_ID` in `library.toml`. | Replace, Delete and detected changes clear the edge cache at once instead of within a day. |
| `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` | An **R2 API token** (R2 → Manage API tokens, a different kind of token): Object Read & Write, on the one media bucket, no expiry. | Masters stored in the bucket, uploaded from the browser. Without it, masters can still be linked by URL. |

## Preflight

```sh
pnpm preflight production
```

Creates nothing. Checks the machine, verifies the token, probes every permission the deploy needs and names any that is missing, confirms R2 is enabled, that a Zero Trust organization exists or can be created, that each hostname is under a zone in your account, and that the optional tokens, if present, are valid. Two things it cannot read with the deploy token: the account's plan and whether Images is enabled. It says so and names the dashboard page; verification after the deploy settles Images for certain. Fix every `FAIL` before going on.

## Provision

```sh
pnpm provision production
```

Creates, or reuses when it already exists: the Zero Trust organization (only with `ACCESS_TEAM_NAME`), the one-time PIN identity provider, the Access application for the library's hostname allowing your email domains, the bucket, its CORS rule for master uploads, and the database. It then writes the team domain, the Access audience tag, the account id, the bucket name and the database id into `library.toml`, and the database id into `resizer.toml`. Safe to run again at any time; re-run it after changing the email domains.

Commit the two files it changed:

```sh
git add environments && git commit -m "production: provisioned"
```

## Deploy

```sh
pnpm check                # builds both Workers without credentials; catches a broken config
pnpm deploy production    # migrations, then the resizer, then the library
```

The library refuses to start until `ACCESS_AUD` is set, so a deploy before provisioning fails closed rather than open. Optional tokens found in `.env` are stored as the library Worker's secrets on every deploy.

## Verify

```sh
pnpm verify production
```

From the outside: the resizer answers, refuses `masters/`, and its metadata API gives a clean 404 for an unknown key; the library redirects to the Access login and never answers without one. With credentials: no migration is left to apply, and the bucket's CORS rule names the library. After your first upload, run it again with `--key media/<a filed key>` and it confirms that resizing works and Images is on.

## First upload and staff

Open `https://media-admin.example.com/`, enter an address on an allowed domain, and type the PIN from the email. Upload a folder of images; the library files them under `media/` and reads any embedded description, keywords, creator and credit into the record. Every image's public URL is `https://img.example.com/<key>`; add `?w=<width>` from the resizer's menu for a size, and the file page gives you the markup.

To let more people in, add their email domain to `ACCESS_ALLOWED_EMAIL_DOMAINS` and run `pnpm provision production` again; the policy is rewritten. For individual addresses outside those domains, add them to the Access application's policy in the dashboard (Zero Trust → Access → Applications), knowing that the next provision run rewrites the domains and keeps nothing else.

Before uploading a shoot, the command-line prep tool in `tools/` fixes names, keeps the descriptive metadata and strips location and device identifiers; see the README.

## A second environment

In the deployment repository, copy `environments/production/` to `environments/staging/`, then change in both files: `name`, the route `pattern`, `bucket_name` and `database_name`, and in `library.toml` also `MEDIA_ORIGIN`, and reset `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`, `CF_ACCOUNT_ID`, `MEDIA_BUCKET` and `database_id` to `REPLACE_…`. Then preflight, provision, deploy and verify `staging`. Environments share nothing, so a mistake in one cannot touch another.

## Upgrading PhotonRelic

```sh
git -C photonrelic fetch origin
git -C photonrelic log --oneline HEAD..origin/master      # what is new
git -C photonrelic checkout <commit>
pnpm setup && pnpm check
pnpm deploy production && pnpm verify production
git add photonrelic && git commit -m "production: PhotonRelic <commit>"
```

Read the commits between the two for anything that asks for a new variable or binding; add it to your `environments/` files before deploying. Migrations are applied by the deploy, in order, and are never edited after they ship, so a database is always upgradable forward. For a fork, fetch from the project first and fast-forward the fork; for a mirror, push the project's `master` into the mirror first.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Worker exceeded CPU time limit` (error 1102) on thumbnails | The account is on the Workers Free plan | Move to Workers Paid, then deploy the resizer again: a running version keeps the limit it was deployed with. |
| The library answers 500 at every URL | `ACCESS_AUD` is a placeholder, or one half of an optional token pair is set | Run provision, then deploy again; set both R2 variables or neither. |
| `still has REPLACE_ placeholders` from the deploy | Provisioning has not run | `pnpm provision <env>`. |
| Preflight: `token lacks …` | The token is missing that permission | Edit the token and add exactly the permission named. |
| Preflight: `… is not under a zone this token can see` | The domain is not in this account, or the token's zone resources exclude it | Add the domain as a zone, or widen the token's Zone Resources to it. |
| Verify: `served as stored: x-media-transform: unavailable` | Images is not enabled | Enable Images; no redeploy needed. |
| Master upload fails in the browser with a CORS error | The bucket's CORS rule does not name the library's origin | `pnpm provision <env>` sets it. |
| Replace says the same bytes are already at this key | The new file is identical to the stored one | Nothing to do; upload a different file or leave it. |
| Nothing answers at a hostname right after the first deploy | The custom domain's DNS record is still propagating | Wait a minute and verify again. |
| The library shows "not configured" for usage or masters | The optional token is not in `.env` | Add it and run `pnpm deploy <env>`; the deploy stores it. |

## What it costs

For a marketing-style site with 200,000 page visits a month and a library of a couple of thousand images, expect **$6 to $12 a month**: the Workers Paid base fee of $5 plus a little CPU for resizes that miss the edge cache, with everything else inside free allowances. Costs track distinct images on busy pages more than visits, since a cache hit is nearly free. The fixed resize menu caps how many unique transformations exist, so a runaway bill is not possible by design. Storing masters in the bucket adds storage at R2's rate, about $0.015 per gigabyte-month, and nothing for uploads or downloads.
