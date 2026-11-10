# Deploying PhotonRelic

This guide takes you from a Cloudflare account to a working library and image origin, with nothing assumed beyond knowing your way around a terminal. It is written for a person; an agent working for you follows the same steps through [`AGENTS.md`](../AGENTS.md). Every command here is run as written; nothing is paraphrased.

The short way is [the installer](#the-installer): the prerequisites, then one command. The sections after it are the same work step by step, for when you want to see each piece or something needs a hand, and then what comes after: staff, a second environment, upgrading, troubleshooting.

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
| A Cloudflare account | dash.cloudflare.com | Everything lives in it. The **account ID** is on the right of the account's home page; you will need it, unless the installer mints your tokens, in which case it reads the ID from the bootstrap token. |
| Your domain as a zone | Websites → Add a domain | Both hostnames must be under a domain whose DNS Cloudflare serves. The Free zone plan is enough. |
| **Workers Paid** plan | Workers & Pages → Plans | Required. A cold resize of a large original takes a few hundred milliseconds of CPU; the Free plan's 10 ms limit kills a page of fresh thumbnails. Base price is $5 a month. |
| **R2** enabled | R2 → Overview → Get started | Object storage. Needs a payment method on the account; usage at library scale sits inside the free allowance. |
| **Images** enabled | Images → Overview | The transformations the resizer uses. Without it every image is served as stored and the resizer says so in a header. |
| **Zero Trust** enabled | Zero Trust → choose the Free plan | Access is part of Zero Trust. You pick a team name, which becomes `<team>.cloudflareaccess.com`, the login page's address. The provisioning script can create this for you if you prefer (`ACCESS_TEAM_NAME`). |

On your machine: Node 22.13 or later, pnpm 10 or later (`npm install -g pnpm@12`; on Node 22 to 24, `corepack enable` also works), git, and curl 7.55 or later. pnpm 10 is the floor because it enforces the list of dependencies allowed to run install scripts.

## The installer

Every [release](https://github.com/PhotonRelic/PhotonRelic/releases) attaches `install.sh`, and its notes end with the file's SHA-256 and the tagged commit. Download it, check it, and run it:

```sh
curl -fsSLO https://github.com/PhotonRelic/PhotonRelic/releases/latest/download/install.sh
shasum -a 256 install.sh        # compare with the release notes (sha256sum on Linux)
sh install.sh
```

To pin the install to the exact code the notes describe, so that a tag moved under you could not change what runs, add `--version vX.Y.Z --commit <the tagged commit from the notes>`; the installer stops if the checkout does not match.

It asks for an environment name, the two hostnames, your account ID, the email domains staff sign in with, and the deploy token (typed without echo, or taken from `CLOUDFLARE_API_TOKEN` in your environment; the [Tokens](#tokens) section says what the token needs). Then it creates the deployment repository in `./photonrelic-deploy`, pinned to the newest release, installs its dependencies, runs preflight, shows what it is about to create and asks once, then provisions, deploys and verifies. When something fails it stops, shows the failure with its fix, and prints the one command that continues from there; running the installer again with the same answers also continues.

Every question has an option, so the whole thing can run without prompts: `--dir`, `--name`, `--library-host`, `--resizer-host`, `--account-id`, `--email-domains`, `--team-name`, `--yes`. `--dry-run` stops after preflight and creates nothing in the account; `--version v1.2.0` installs that release instead of the newest; `--commit <sha>` requires it to be that exact commit; `--source <url>` installs from your fork or mirror over `https://`, `ssh://` or `git@host:`, never a plaintext scheme. `--mint`, `--usage`, `--purge`, `--masters` and `--retire-bootstrap` belong to the token-minting path described under [Tokens](#or-let-the-installer-mint-them). `sh install.sh --help` lists them all.

When it finishes, sign in at the library's address, upload a folder, and commit the deployment repository (it tells you how). The sections from [Create the deployment repository](#create-the-deployment-repository) to [Verify](#verify) are what it just did, one step at a time.

## Where your copy of the code lives

The deployment repository points at PhotonRelic as a git submodule, pinned to a release. The default is right for almost everyone:

- **The public project** (`https://github.com/PhotonRelic/PhotonRelic.git`), pinned to a release tag. Nothing to maintain, upgrades are one command, and nothing changes until you run it. Your deployment does not depend on this repository being reachable: the Workers run in your account, and your checkout holds the code. The release's source archive is a complete copy you can keep.
- **Your GitHub fork.** When your team will change the code, or wants a copy GitHub keeps for them if the project ever disappears. Fork on GitHub, pass `--source` with the fork's URL, and keep it current with GitHub's **Sync fork** button or `git fetch upstream && git merge --ff-only upstream/master`. Sync moves branches only; fetch the project's tags too (`git fetch upstream --tags && git push origin --tags`) so releases are visible in the fork. Changes you make go on a branch and come back to the project as a pull request. A fork of a public repository is public by GitHub's rules and cannot be made private; that is fine, because your deployment configuration never goes in it.
- **A private mirror.** When your organization forbids public repositories, or wants a private copy as insurance. Create an empty private repository, push the project's `master` and its tags into it, never commit to it, and fast-forward it from the project when you upgrade. Nothing flows back to the project except by hand.

Whichever you choose, the deployment repository itself is **private**: the ids and hostnames the provisioning script writes into it belong to your account.

## Create the deployment repository

From a checkout of PhotonRelic (the project, your fork or your mirror):

```sh
sh scripts/init-deploy-repo.sh ../my-photonrelic-deploy \
  --name production \
  --library-host media-admin.example.com \
  --resizer-host img.example.com
```

Add `--source <git url>` for a fork or mirror; the default is the public project. The submodule is pinned to the newest release at the source; `--ref v1.2.0` pins another, and `--ref <commit>` a commit. The result is a new git repository, staged and not committed, holding:

```
photonrelic/                       PhotonRelic as a submodule, pinned to a release
environments/production/library.toml   the library Worker's configuration, names filled in
environments/production/resizer.toml   the resizer Worker's configuration
scripts/{preflight,provision,deploy,verify,upgrade}.sh   wrappers that call PhotonRelic's scripts
package.json                       pnpm run setup / check / preflight / provision / deploy / verify / upgrade-photonrelic
.env.example                       the credentials file to copy
README.md                          these steps, for this repository
```

Read the two TOML files once. The hostnames, Worker names, bucket name and database name are filled in from `--name` and the hosts. The `REPLACE_` values are filled in by provisioning. In `resizer.toml`, uncomment `ALLOWED_ORIGINS` and list your websites if only your own pages may embed images; uncomment `LIBRARY_HOST` so the library's pages can still show a file whose rights have expired.

Then:

```sh
cd ../my-photonrelic-deploy
git commit -m "PhotonRelic deployment repository"
pnpm run setup
```

The commands in this repository are always `pnpm run <name>`. pnpm has built-in commands called `setup` and `deploy`, and without `run` it runs those instead of the scripts.

Create a private repository on GitHub for it and push, when you are ready. Nothing secret is in it; it is private because it is yours.

## Tokens

Tokens are created at **My Profile → API Tokens → Create Token → Create Custom Token**, or under the account's **Manage Account → Account API Tokens**. Copy each one into `.env` as you make it; the dashboard shows a token once. Create the file readable by you alone:

```sh
(umask 077; cp .env.example .env)
```

Preflight fails when `.env` is readable by other users on the machine. The scripts read it line by line and never execute it, and they keep its values out of the environment of everything they run except wrangler, which gets the deploy token and the account ID and nothing else.

**The deploy token** (`CLOUDFLARE_API_TOKEN`), one token with these permissions and nothing more. Its account permissions cover every Worker, bucket, database and Access application in the account, which is what deploying needs; its zone permissions cover only the zone your hostnames are in:

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

**Optional tokens**, each turning on one feature. Skip them now; add them later and run `pnpm run deploy` again.

| Variable | Token | Feature |
| --- | --- | --- |
| `ANALYTICS_TOKEN` | Account → Account Analytics → Read | Usage counts per file and the "unused in 90 days" list. |
| `CACHE_PURGE_TOKEN` | Zone → Cache Purge → Purge, on the resizer's zone. Also uncomment `CF_ZONE_ID` in `library.toml`. | Replace, Delete and detected changes clear the edge cache at once instead of within a day. |
| `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` | An **R2 API token** (R2 → Manage API tokens, a different kind of token): Object Read & Write, on the one media bucket, no expiry. `mint-tokens.sh --masters` makes it for you once the bucket exists. | Masters stored in the bucket, uploaded from the browser. Without it, masters can still be linked by URL. |

### Or let the installer mint them

Instead of building the deploy token and the optional ones by hand, you can create a single **bootstrap token** and let the scripts create the rest through the API, each named `photonrelic-<env>-<purpose>`: the deploy token with the account permissions above and zone permissions on your hostnames' zones only, and the optional tokens each scoped to its one job.

The bootstrap token has one permission, **Account → Account API Tokens → Edit**, on your one account, and it must be account-owned (made under **Manage Account**, not **My Profile**): that is what lets `--retire-bootstrap` delete it at the end, and it makes the tokens it mints belong to the account rather than to a person. A user token from My Profile is refused: the script deletes it on the spot when the token allows that, otherwise tells you to, and asks for an account-owned one. To make it, once:

1. Open [this link](https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=%5B%7B%22key%22%3A%22account_api_tokens%22%2C%22type%22%3A%22edit%22%7D%5D&name=PhotonRelic%20bootstrap) signed in to Cloudflare. It opens the account token form with the one permission filled in. By hand instead: **Manage Account → Account API Tokens → Create Token → Create Custom Token**, one permission row, **Account · Account API Tokens · Edit**.
2. **Account Resources**: Include, your one account. No zone permission is needed.
3. **TTL**: today to tomorrow. **Client IP Address Filtering**: your IP, if you know it. The script warns when a token has no expiry.
4. **Continue to summary → Create Token**. Copy the token; it is shown once. The installer asks for it at a hidden prompt, and the same text is printed there.

The page also shows your account ID. You do not need to copy it: the token is scoped to that one account, and the installer reads the ID from it, so the account question is skipped on this path. It needs no zone permission: the deploy token it mints starts with every zone in the account, looks up the zones of your two hostnames with its own permissions, and is narrowed to those before it is written anywhere. If that narrowing cannot be done, the new token is deleted and nothing is written. Then:

```sh
sh install.sh --mint --usage --purge --masters --retire-bootstrap
```

The installer asks for the bootstrap token at a hidden prompt, keeps it in its own memory, and hands it only to the two minting steps; no other process it runs can see it, and it never goes into a file or your shell history. To run without a prompt (for an agent, or a script), put it in the environment with `read -rs CLOUDFLARE_BOOTSTRAP_TOKEN && export CLOUDFLARE_BOOTSTRAP_TOKEN` and paste it at the silent prompt; an `export CLOUDFLARE_BOOTSTRAP_TOKEN=…` line would land in your shell history. The installer mints the deploy token before preflight, the usage and purge tokens with it, the R2 key pair after provisioning has created the bucket (`--masters`), and sets `CF_ZONE_ID` for the purge. The same thing on an existing deployment repository, for one token at a time:

```sh
read -rs CLOUDFLARE_BOOTSTRAP_TOKEN && export CLOUDFLARE_BOOTSTRAP_TOKEN
sh photonrelic/scripts/mint-tokens.sh environments/production --purge
```

A variable already set in `.env` is left alone, except that an existing deploy token is checked: if it still covers every zone in the account, the script stops and tells you to delete it and mint again. Be clear about what the bootstrap token is: a token that can create tokens can create one with any permission in the account, so it is as powerful as the account itself while it exists. The short expiry, the IP filter and deleting it afterwards are what make it a reasonable thing to hand to a script or an agent. Everything it created is listed under **Manage Account → Account API Tokens**.

**Delete the bootstrap token when the installation is done.** `--retire-bootstrap` does it for you at the end of a successful install; the script also deletes it on `sh photonrelic/scripts/mint-tokens.sh environments/production --retire-bootstrap`. If the install stopped partway, or you ran without the flag, the installer says so and prints that command. Until it is gone, anyone with the token can mint one with any permission in your account; a day's expiry is the backstop, not the plan.

## Preflight

```sh
pnpm run preflight production
```

Creates nothing. Checks the machine (Node, pnpm 10, curl 7.55, dependencies installed), that `.env` is readable by you alone, that `library.toml` has an `ACCESS_AUD` line and is not in local mode, verifies the token, probes every permission the deploy needs and names any that is missing, confirms R2 is enabled, that a Zero Trust organization exists or can be created, that each hostname is under a zone in your account, and that the optional tokens, if present, are valid. Two things it cannot read with the deploy token: the account's plan and whether Images is enabled. It says so and names the dashboard page; verification after the deploy settles Images for certain. Fix every `FAIL` before going on.

## Provision

```sh
pnpm run provision production
```

Creates, or reuses when it already exists: the Zero Trust organization (only with `ACCESS_TEAM_NAME`), the one-time PIN identity provider, the Access application for the library's hostname allowing your email domains, the bucket, its CORS rule for master uploads, and the database. It then writes the team domain, the Access audience tag, the account id, the bucket name and the database id into `library.toml`, and the database id into `resizer.toml`. Safe to run again at any time; re-run it after changing the email domains.

Commit the two files it changed:

```sh
git add environments && git commit -m "production: provisioned"
```

## Deploy

```sh
pnpm run check                # builds both Workers without credentials; catches a broken config
pnpm run deploy production    # migrations, then the resizer, then the library
```

The library refuses to start until `ACCESS_AUD` is set, so a deploy before provisioning fails closed rather than open, and `deploy.sh` itself refuses a `library.toml` that has no `ACCESS_AUD` line or that sets `ENVIRONMENT = "local"`. Optional tokens found in `.env` are stored as the library Worker's secrets on every deploy; wrangler is the only program the scripts hand the deploy token to.

## Verify

```sh
pnpm run verify production
```

From the outside: the resizer answers, refuses `masters/`, and its metadata API gives a clean 404 for an unknown key; the library redirects to the Access login and never answers without one. With credentials: no migration is left to apply, and the bucket's CORS rule names the library. After your first upload, run it again with `--key media/<a filed key>` and it confirms that resizing works and Images is on. If your own machine's resolver has not yet heard of a new hostname, verify resolves it through Cloudflare's resolver and says so in a note; the deployment is judged, not your laptop.

## First upload and staff

Open `https://media-admin.example.com/`, enter an address on an allowed domain, and type the PIN from the email. Upload a folder of images; the library files them under `media/` and reads any embedded description, keywords, creator and credit into the record. Every image's public URL is `https://img.example.com/<key>`; add `?w=<width>` from the resizer's menu for a size, and the file page gives you the markup.

To let more people in, add their email domain to `ACCESS_ALLOWED_EMAIL_DOMAINS` and run `pnpm run provision production` again; the policy is rewritten. For individual addresses outside those domains, add them to the Access application's policy in the dashboard (Zero Trust → Access → Applications), knowing that the next provision run rewrites the domains and keeps nothing else.

Before uploading a shoot, the command-line prep tool in `tools/` fixes names, keeps the descriptive metadata and strips location and device identifiers; see the README.

## A second environment

In the deployment repository, copy `environments/production/` to `environments/staging/`, then change in both files: `name`, the route `pattern`, `bucket_name` and `database_name`, and in `library.toml` also `MEDIA_ORIGIN`, and reset `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`, `CF_ACCOUNT_ID`, `MEDIA_BUCKET` and `database_id` to `REPLACE_…`. Then preflight, provision, deploy and verify `staging`. Environments share nothing, so a mistake in one cannot touch another.

## Upgrading PhotonRelic

Nothing changes until you run this. Releases are tags `vX.Y.Z`; each one's notes, in [`CHANGELOG.md`](../CHANGELOG.md) and on its release page, say what changed and, first, what an operator must do.

```sh
pnpm run upgrade-photonrelic production            # to the newest release
pnpm run upgrade-photonrelic production v1.2.0     # to a particular one
```

It fetches the tags, shows the changelog sections between your pin and the target, and asks. Read **Operators must do** before saying yes; a new variable or binding goes into your `environments/` files first. Then it moves the submodule to the release, installs, builds, deploys, verifies and commits the pin. If the deploy fails it tells you how to finish or how to go back. Migrations are applied by the deploy, in order, and are never edited after they ship, so a database is always upgradable forward; a downgrade is refused unless you pass `--allow-downgrade`, and the database keeps every migration already applied.

Version numbers from your side: a **major** version means you must do something (the notes say what), a **minor** one adds features, a **patch** fixes. A release candidate (`v1.2.0-rc.1`) is published as a pre-release, never becomes the newest release, and is skipped unless you name it; it is how maintainers deploy a version before anyone else does.

For a fork or mirror, the upgrade needs the project's tags in it: `git fetch https://github.com/PhotonRelic/PhotonRelic.git --tags && git push <your remote> --tags`, then fast-forward its `master`. A deployment repository created before releases existed is pinned to a commit and has no `upgrade` wrapper; run `sh photonrelic/scripts/upgrade.sh environments/production` once (after moving the submodule to any release that has it), and the next scaffold has the wrapper.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Worker exceeded CPU time limit` (error 1102) on thumbnails | The account is on the Workers Free plan | Move to Workers Paid, then deploy the resizer again: a running version keeps the limit it was deployed with. |
| The library answers 500 at every URL | `ACCESS_AUD` is a placeholder, or one half of an optional token pair is set | Run provision, then deploy again; set both R2 variables or neither. |
| `still has REPLACE_ placeholders` from the deploy | Provisioning has not run | `pnpm run provision <env>`. |
| Preflight: `token lacks …` | The token is missing that permission | Edit the token and add exactly the permission named. |
| Preflight: `… is not under a zone this token can see` | The domain is not in this account, or the token's zone resources exclude it | Add the domain as a zone, or widen the token's Zone Resources to it. |
| Verify: `served as stored: x-media-transform: unavailable` | Images is not enabled | Enable Images; no redeploy needed. |
| Master upload fails in the browser with a CORS error | The bucket's CORS rule does not name the library's origin | `pnpm run provision <env>` sets it. |
| Replace says the same bytes are already at this key | The new file is identical to the stored one | Nothing to do; upload a different file or leave it. |
| Nothing answers at a hostname right after the first deploy | The custom domain's DNS record is still propagating | Wait a minute and verify again. |
| The library shows "not configured" for usage or masters | The optional token is not in `.env` | Add it and run `pnpm run deploy <env>`; the deploy stores it. |
| The installer stopped partway | One step failed; it printed the failure and the command that continues | Fix what it reported, then run that command, or run the installer again with the same answers. Provisioning is idempotent. |
| Upgrade: `no release tags` | A fork or mirror without the project's tags | `git fetch https://github.com/PhotonRelic/PhotonRelic.git --tags && git push <your remote> --tags`. |
| Upgrade: `is older than the current pin` | The target is a release behind the one deployed | Pick a newer release, or pass `--allow-downgrade` knowing migrations stay applied. |
| Upgrade: `the deployment repository has uncommitted changes` | The submodule pin or a config file is changed but not committed | Commit it (or `git submodule update` to return the pin to the committed one), then upgrade. |
| Preflight: `.env is readable by` others | The file was created with default permissions | `chmod 600 .env`. |
| Preflight or deploy: `library.toml is in local mode` or `has no ACCESS_AUD line` | A development config was copied into an environment | Start from `deploy/example/library.toml`; `ENVIRONMENT` is a label, never `local` in a deployment. |
| Mint: `this bootstrap token is user-owned` | The token was made under My Profile | Make an account-owned one under Manage Account → Account API Tokens; the script deletes the user one when it can. |
| Mint: `does not name exactly one account` | The bootstrap token spans several accounts, or none | Scope it to the one account, or pass `--account-id`. |

## What it costs

For a marketing-style site with 200,000 page visits a month and a library of a couple of thousand images, expect **$6 to $12 a month**: the Workers Paid base fee of $5 plus a little CPU for resizes that miss the edge cache, with everything else inside free allowances. Costs track distinct images on busy pages more than visits, since a cache hit is nearly free. The fixed resize menu caps how many unique transformations exist, so a runaway bill is not possible by design. Storing masters in the bucket adds storage at R2's rate, about $0.015 per gigabyte-month, and nothing for uploads or downloads.
