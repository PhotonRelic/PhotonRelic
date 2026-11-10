# PhotonRelic, for the agent deploying it

You are deploying PhotonRelic into a Cloudflare account for the person you are working with. This file tells you what the project is, how to proceed, what to ask them for, and what never to do. The long form for people is [`docs/deploy.md`](docs/deploy.md); follow this file and read that one when a step needs more.

## What this is

PhotonRelic is a digital asset manager for images that runs entirely on Cloudflare: a public **resizer** Worker that serves and resizes images from a fixed menu, a private **library** Worker behind Cloudflare Access where staff upload and describe files, one **R2** bucket, one **D1** database. Deployment configuration lives in a separate **private** repository that holds PhotonRelic as a git submodule; this public repository holds the code, the scripts and a template.

## Repository map

| Path | What |
| --- | --- |
| `workers/resizer/`, `workers/library/` | The two Workers. You do not edit them to deploy. |
| `workers/library/migrations/` | Database migrations, applied in order by the deploy. Never edit one that exists. |
| `packages/media-params/` | The resize menu and URL builder shared with websites. |
| `deploy/example/` | The template a deployment is made from. Everything else under `deploy/` is ignored by git. |
| `scripts/install.sh` | The whole procedure below from one command; every question has a flag. Attached to every release. |
| `scripts/mint-tokens.sh` | Creates the deployment's API tokens from one bootstrap token, each named and scoped to one job; the installer calls it when `CLOUDFLARE_BOOTSTRAP_TOKEN` is set. |
| `scripts/init-deploy-repo.sh` | Creates the private deployment repository, pinned to a release. |
| `scripts/preflight.sh` | Checks the machine, token and account before anything is created. |
| `scripts/provision.sh` | Creates the Access application, bucket, database; writes ids into the config. |
| `scripts/deploy.sh` | Applies migrations, deploys both Workers, stores optional secrets. |
| `scripts/verify.sh` | Checks the deployed result from the outside. |
| `scripts/upgrade.sh` | In a deployment repository: moves the pin to a newer release, deploys, verifies, commits. |
| `CHANGELOG.md` | Every release, with **Operators must do** first. Read it before an upgrade. |
| `tools/prep-images.py` | Prepares a shoot on the photographer's machine before upload. Not part of deploying. |

## Rules

1. **Never ask for or handle a token value in the conversation.** The person creates tokens in the Cloudflare dashboard and puts them into `.env` or their own shell environment themselves. You tell them which permissions a token needs (the table in `docs/deploy.md`, Tokens, or the one for a bootstrap token) and which variable name to use. If a token is wrong, preflight says so; you relay the message. Never print the environment (`env`, `printenv`, `set`, `export -p`) or read `.env` back: a token in your environment would land in the transcript.
2. **Run preflight before provision, and `pnpm run check` before deploy.** Both create nothing. Do not skip them to save time.
3. **Stop and report on any `FAIL` or API error.** Do not retry the same command hoping for a different result, and do not work around a failed check.
4. **Never commit deployment configuration into this public repository.** Everything under `deploy/` except the example is ignored for that reason. The deployment repository is the place, and it is private.
5. **Never edit a migration that exists, and never run SQL against the database by hand.** The deploy applies migrations.
6. **Do not change the Workers' code to make a deployment work.** If the configuration cannot express what is needed, say so.
7. **Do not put the person's hostnames, account id, database id or Access tags into any file of this repository**, into an issue, or into a pull request. They belong in the deployment repository only.
8. **Deploy releases, not `master`.** The scaffold and the installer pin the newest release; leave it there unless the person names another. Never move a deployment to a release candidate (`-rc.`) unless they ask for that one.

## What to ask the person, and when

Ask these before step 2. Everything else you can find out or decide.

| Ask for | Why | Example |
| --- | --- | --- |
| Which repository holds the code: the public project, their fork, or a private mirror | It is the submodule's source | "the public project" |
| A short name for the environment | Names the Workers, bucket and database | `production` |
| The library's hostname (staff, private) | A custom domain under a zone in their account | `media-admin.example.com` |
| The resizer's hostname (public) | Same | `img.example.com` |
| The email domains staff sign in with | The Access policy | `example.com` |
| Their Cloudflare account ID | For `.env`; shown on the account's home page. Not needed on the bootstrap path: the installer reads it from the bootstrap token. | (32 hex characters) |
| Whether they want to create the tokens themselves, or give you one bootstrap token that mints them | Decides between the two paths below | "mint them" |
| Confirmation that the account is on Workers Paid and has R2, Images and Zero Trust enabled | Preflight cannot read the plan or Images with the deploy token | yes / no |
| Whether they want the optional features now: usage counts, cache purge, masters in the bucket | Each needs a token they create | later |

## Procedure

Each step gives the command and what a good result looks like. Run commands as written.

**The fully automated way: one bootstrap token.** The person does not have to build the deploy token's seven permissions in the dashboard, nor the optional ones. They create one token with one permission, **Account → Account API Tokens → Edit**, scoped to their one account, with an expiry of a day and, if they can, their IP address. Give them the four steps from `docs/deploy.md`, "Or let the installer mint them", including the link that opens the account token form with the one permission filled in; the installer prints the same steps before it asks. It must be made under **Manage Account → Account API Tokens** (account-owned): the script refuses a user token from My Profile, deletes it when it can, and asks for an account-owned one, because only that kind can delete itself at the end and the tokens it mints then belong to the account. They put it in the environment you run in with `read -rs CLOUDFLARE_BOOTSTRAP_TOKEN && export CLOUDFLARE_BOOTSTRAP_TOKEN`, typed by them at the silent prompt so it never enters their shell history or your transcript; or, when you run the installer in their terminal, the installer itself asks for it at a hidden prompt (`--mint`). With that, the installer mints every token the deployment needs through the API, each named `photonrelic-<env>-<purpose>`: the deploy token, with the account permissions deploying needs (every Worker, bucket, database and Access application in the account) and zone permissions on the hostnames' zones only, plus `--usage` (Account Analytics Read), `--purge` (Cache Purge on the resizer's zone, with `CF_ZONE_ID` set for you) and `--masters` (an R2 key pair on the one media bucket, minted after provisioning creates the bucket). Each lands in the deployment repository's `.env`, mode 600; the bootstrap token is kept out of every process but the two minting steps and is never written to a file. `--retire-bootstrap` deletes the bootstrap token at the end, so nothing powerful outlives the installation. Pass `--commit <sha>` from the release notes when the person wants the install pinned to exact code.

```sh
sh scripts/install.sh --dir ../<dir> --name <env> --library-host <library host> --resizer-host <resizer host> \
  --email-domains <domains> --mint --usage --purge --masters --retire-bootstrap --yes
```

Be straight with the person about what that token is: a token that can mint tokens is as powerful as anything it mints, which for this account is everything. The expiry, the IP filter and `--retire-bootstrap` are what make it acceptable; say so when you ask for it. **Always pass `--retire-bootstrap`** unless the person says they will reuse the token for another environment, and in that case tell them at hand-over that it is still valid and where to delete it. If the install stops partway, the installer prints the retire command; run it, or relay it, before anything else. Never leave a bootstrap token behind without the person knowing. Afterwards they can audit what was created under **Manage Account → Account API Tokens**, where every token this run made is named `photonrelic-<env>-…`. Without `CLOUDFLARE_BOOTSTRAP_TOKEN` in your environment the installer behaves as below and the person creates the deploy token themselves.

**The short way with their own deploy token.** Once the person has created the token and put it in their own environment (`export CLOUDFLARE_API_TOKEN=…` in their shell, done by them, not by you), the installer does steps 2 to 8 in one run. First without creating anything:

```sh
sh scripts/install.sh --dir ../<dir> --name <env> --library-host <library host> --resizer-host <resizer host> \
  --account-id <account id> --email-domains <domains> --yes --dry-run
```

Good: `preflight: N passed, 0 failed` and `dry run: nothing was created`. Then the same command without `--dry-run`, which provisions, deploys and verifies and ends with `installed. Sign in at …`. If it stops, it prints the failure with its `fix:` and the command that continues; relay the failure, and when it is fixed run that command or the installer again. Without `CLOUDFLARE_API_TOKEN` in the environment the installer asks for the token at a hidden prompt, which only the person can answer; it never takes the token as an argument. The steps below are the same work one at a time.

**1. Check the machine.** `node --version` is 22.13 or later; `pnpm --version` is 10 or later (if missing or older: `npm install -g pnpm@12`); `git` exists; `curl --version` is 7.55 or later. In the deployment repository every command is `pnpm run <name>`: pnpm's own `setup` and `deploy` commands shadow the scripts when `run` is left out.

**2. Create the deployment repository.** From this repository's root:

```sh
sh scripts/init-deploy-repo.sh ../<dir> --name <env> --library-host <library host> --resizer-host <resizer host> [--source <fork or mirror url>]
```

Good: it prints `done: … is staged, not committed` and the four next commands. Then `cd ../<dir>`, show the person `environments/<env>/library.toml` and `resizer.toml`, and ask whether only their own sites may embed images; if so, uncomment `ALLOWED_ORIGINS` in `resizer.toml` and list them. Commit: `git commit -m "PhotonRelic deployment repository"`. Then `pnpm run setup`.

**3. Credentials.** `(umask 077; cp .env.example .env)`, so the file is readable by them alone. Tell the person to create the deploy token with the permissions in `docs/deploy.md` (Tokens) and to put it, the account ID and the email domains into `.env`. Wait for them to say it is done. Do not read `.env` back to them.

**4. Preflight.** `pnpm run preflight <env>`. Good: `preflight: N passed, 0 failed` and a `next:` line. Each `FAIL` line carries its own `fix:`; relay it and stop until it is fixed. The two `note` lines about the plan and Images are expected: ask the person to confirm them in the dashboard if they have not.

**5. Provision.** `pnpm run provision <env>`. Good: `done. Next: …` after lines ending in `created` or `exists`. Then `git add environments && git commit -m "<env>: provisioned"`.

**6. Build.** `pnpm run check`. Good: two `--dry-run: exiting now.` lines and no error.

**7. Deploy.** `pnpm run deploy <env>`. Good: migrations applied (or `No migrations to apply`), then `Deployed photonrelic-<env>-resizer` and `Deployed photonrelic-<env>` with their custom domains.

**8. Verify.** `pnpm run verify <env>`. Good: `verify: N passed, 0 failed` and `ready: sign in at https://<library host>/`. A `note` saying a hostname resolves through 1.1.1.1 but not locally is this machine's resolver lagging, not a failure. If a hostname does not resolve anywhere yet, wait one minute and run it again before treating it as a failure.

**9. Hand over.** Tell the person to sign in at the library's address with an email on an allowed domain, upload a folder, open a file page, and copy the markup. After that first upload, run `pnpm run verify <env> --key <a filed key>` to confirm resizing and Images.

**10. The deployment repository's home.** It holds only configuration and the pin; `.env` is ignored and never leaves the machine. Offer the person a private remote for it, and say plainly what it buys: working on the deployment from a second machine, a second pair of hands, and a history of when the pin moved. Nothing in it is irreplaceable: if the machine were lost, the installer would recreate the repository against the same resources in minutes, since provisioning finds what already exists. For one person on one machine, declining is a fine answer. If they want it and `gh` is signed in, do it for them, private from the first command, and check:

```sh
cd <dir> && git add -A && git commit -m "<env>: PhotonRelic deployed"
gh repo create <owner>/<name> --private --source . --push
gh repo view <owner>/<name> --json visibility --jq .visibility     # must print PRIVATE
```

If the last line prints anything but `PRIVATE`, stop and make it private before anything else (`gh repo edit <owner>/<name> --visibility private --accept-visibility-change-consequences`), then tell the person. Never create it public, and never push the deployment repository to a remote they did not name.

## Afterwards

- **Add staff:** add their email domain to `ACCESS_ALLOWED_EMAIL_DOMAINS` in `.env`, run `pnpm run provision <env>` again.
- **Turn on an optional feature:** the person adds the token to `.env` (and for cache purge uncomments `CF_ZONE_ID` in `library.toml`), then `pnpm run deploy <env>`.
- **Upgrade PhotonRelic:** in the deployment repository, `pnpm run upgrade-photonrelic <env>` (or `… <env> vX.Y.Z`). It prints the changelog between the pin and the target and asks; read **Operators must do** to the person and stop until anything it asks for is in place, then confirm (or pass `--yes` when they have agreed). Good: `done: <env> is on vX.Y.Z and the pin is committed.` Never pass `--allow-downgrade` unless they ask for an older release by name.
- **A second environment:** `docs/deploy.md`, A second environment.

## When something fails

Use the troubleshooting table in `docs/deploy.md`. The ones you will meet most:

| You see | Do |
| --- | --- |
| `token lacks <permission>` | Tell the person which permission to add to the token; run preflight again. |
| `<host> is not under a zone this token can see` | The domain is not in the account, or the token's zone resources exclude it. Ask. |
| `still has REPLACE_ placeholders` | Run provision. |
| `Worker exceeded CPU time limit` on thumbnails | The account is on Workers Free. Ask the person to move to Workers Paid, then deploy the resizer again. |
| `served as stored: x-media-transform: unavailable` | Images is not enabled. Ask the person to enable it; no redeploy. |
| The library answers 500 | Provision did not run, or one half of the R2 token pair is set. Fix `.env`, deploy again. |
| Upgrade: `no release tags` | The fork or mirror lacks the project's tags. Tell the person the two git commands in `docs/deploy.md`, Upgrading. |
| Upgrade: `the deployment repository has uncommitted changes` | Commit the pending change in the deployment repository, or `git submodule update` to return the pin to the committed one, then upgrade. |
| Preflight: `.env is readable by` others | `chmod 600 .env`, then preflight again. |
| `library.toml is in local mode` or `has no ACCESS_AUD line` | The config was not made from `deploy/example`. Fix the file; never set `ENVIRONMENT = "local"` in a deployment. |
| Mint: `this bootstrap token is user-owned` | Ask the person for an account-owned token (Manage Account → Account API Tokens); the script deleted the user one if it could, otherwise tell them to. |

If the table does not cover it, show the person the exact output and stop.
