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
| `scripts/init-deploy-repo.sh` | Creates the private deployment repository. |
| `scripts/preflight.sh` | Checks the machine, token and account before anything is created. |
| `scripts/provision.sh` | Creates the Access application, bucket, database; writes ids into the config. |
| `scripts/deploy.sh` | Applies migrations, deploys both Workers, stores optional secrets. |
| `scripts/verify.sh` | Checks the deployed result from the outside. |
| `tools/prep-images.py` | Prepares a shoot on the photographer's machine before upload. Not part of deploying. |

## Rules

1. **Never ask for or handle a token value in the conversation.** The person creates tokens in the Cloudflare dashboard and puts them into `.env` themselves. You tell them which permissions a token needs (the table in `docs/deploy.md`, Tokens) and which variable name to use. If a token is wrong, preflight says so; you relay the message.
2. **Run preflight before provision, and `pnpm check` before deploy.** Both create nothing. Do not skip them to save time.
3. **Stop and report on any `FAIL` or API error.** Do not retry the same command hoping for a different result, and do not work around a failed check.
4. **Never commit deployment configuration into this public repository.** Everything under `deploy/` except the example is ignored for that reason. The deployment repository is the place, and it is private.
5. **Never edit a migration that exists, and never run SQL against the database by hand.** The deploy applies migrations.
6. **Do not change the Workers' code to make a deployment work.** If the configuration cannot express what is needed, say so.
7. **Do not put the person's hostnames, account id, database id or Access tags into any file of this repository**, into an issue, or into a pull request. They belong in the deployment repository only.

## What to ask the person, and when

Ask these before step 2. Everything else you can find out or decide.

| Ask for | Why | Example |
| --- | --- | --- |
| Which repository holds the code: the public project, their fork, or a private mirror | It is the submodule's source | "the public project" |
| A short name for the environment | Names the Workers, bucket and database | `production` |
| The library's hostname (staff, private) | A custom domain under a zone in their account | `media-admin.example.com` |
| The resizer's hostname (public) | Same | `img.example.com` |
| The email domains staff sign in with | The Access policy | `example.com` |
| Their Cloudflare account ID | For `.env`; shown on the account's home page | (32 hex characters) |
| Confirmation that the account is on Workers Paid and has R2, Images and Zero Trust enabled | Preflight cannot read the plan or Images with the deploy token | yes / no |
| Whether they want the optional features now: usage counts, cache purge, masters in the bucket | Each needs a token they create | later |

## Procedure

Each step gives the command and what a good result looks like. Run commands as written.

**1. Check the machine.** `node --version` is 22.13 or later; `pnpm --version` works (if not: `corepack enable`); `git` and `curl` exist.

**2. Create the deployment repository.** From this repository's root:

```sh
sh scripts/init-deploy-repo.sh ../<dir> --name <env> --library-host <library host> --resizer-host <resizer host> [--source <fork or mirror url>]
```

Good: it prints `done: … is staged, not committed` and the four next commands. Then `cd ../<dir>`, show the person `environments/<env>/library.toml` and `resizer.toml`, and ask whether only their own sites may embed images; if so, uncomment `ALLOWED_ORIGINS` in `resizer.toml` and list them. Commit: `git commit -m "PhotonRelic deployment repository"`. Then `pnpm install && pnpm setup`.

**3. Credentials.** `cp .env.example .env`. Tell the person to create the deploy token with the permissions in `docs/deploy.md` (Tokens) and to put it, the account ID and the email domains into `.env`. Wait for them to say it is done. Do not read `.env` back to them.

**4. Preflight.** `pnpm preflight <env>`. Good: `preflight: N passed, 0 failed` and a `next:` line. Each `FAIL` line carries its own `fix:`; relay it and stop until it is fixed. The two `note` lines about the plan and Images are expected: ask the person to confirm them in the dashboard if they have not.

**5. Provision.** `pnpm provision <env>`. Good: `done. Next: …` after lines ending in `created` or `exists`. Then `git add environments && git commit -m "<env>: provisioned"`.

**6. Build.** `pnpm check`. Good: two `--dry-run: exiting now.` lines and no error.

**7. Deploy.** `pnpm deploy <env>`. Good: migrations applied (or `No migrations to apply`), then `Deployed photonrelic-<env>-resizer` and `Deployed photonrelic-<env>` with their custom domains.

**8. Verify.** `pnpm verify <env>`. Good: `verify: N passed, 0 failed` and `ready: sign in at https://<library host>/`. If a hostname does not answer yet, wait one minute and run it again before treating it as a failure.

**9. Hand over.** Tell the person to sign in at the library's address with an email on an allowed domain, upload a folder, open a file page, and copy the markup. After that first upload, run `pnpm verify <env> --key <a filed key>` to confirm resizing and Images. Remind them to create a private GitHub repository for `<dir>` and push it.

## Afterwards

- **Add staff:** add their email domain to `ACCESS_ALLOWED_EMAIL_DOMAINS` in `.env`, run `pnpm provision <env>` again.
- **Turn on an optional feature:** the person adds the token to `.env` (and for cache purge uncomments `CF_ZONE_ID` in `library.toml`), then `pnpm deploy <env>`.
- **Upgrade PhotonRelic:** `docs/deploy.md`, Upgrading. Read the commits in between for a new variable before deploying.
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

If the table does not cover it, show the person the exact output and stop.
