# Contributing

Thanks for helping with PhotonRelic. This page is short because the project
is small; when in doubt, open an issue and ask.

## Before you start

- **Bugs and small fixes:** open a pull request straight away.
- **New features or behavior changes:** open an issue first so we can agree
  on the shape before you write it. PhotonRelic stays deliberately small: a
  fixed resize menu, a bucket-first library, nothing overwritten.
- **Security problems:** see [SECURITY.md](SECURITY.md); please do not open
  a public issue.

## Working on it

You need Node 22.13 or later and pnpm 9 or later (`npm install -g pnpm@12`;
pnpm then switches itself to the version `package.json` names).

```sh
pnpm install
pnpm test          # all packages
pnpm typecheck
pnpm lint          # biome; `pnpm lint:fix` formats
```

`README.md` explains how to run both Workers locally against a shared local
R2 and D1. Please add or update tests with your change; the suite is fast and
runs on every pull request.

## Pull requests

- One change per pull request. Separate concerns go in separate pull
  requests, because each one is squash-merged into a single commit.
- The pull request title and description become that commit's message.
  Write the description for someone reading `git log` in a year: what
  changed and why, not how you got there.
- Keep the README and the configuration table in step with any new variable
  or behavior.
- Add a line to `CHANGELOG.md` under `## [Unreleased]`, written for the
  person running a deployment. If they must do something when they upgrade
  (a new variable, a token, a dashboard switch), put it under
  `### Operators must do`; a migration that runs is worth a line too.
- CI must pass: lint, typecheck, tests. Pull requests from forks skip one
  internal check that maintainers run themselves.
- Do not include deployment details (hostnames, account or database ids,
  Access tags) in code, tests or messages. Everything under `deploy/` except
  the example is ignored for that reason.

## Working from a fork

Fork the repository on GitHub, branch from `master` in your fork, and open
the pull request from that branch. Keep the fork current with GitHub's
**Sync fork** button or `git fetch upstream && git merge --ff-only
upstream/master` before you branch. A fork of a public repository is public,
so your deployment configuration never goes in it: `docs/deploy.md` describes
the private deployment repository that points at your fork as a submodule.

## Releasing (maintainers)

A release is a signed tag `vX.Y.Z` on `master`, a GitHub Release whose notes
are that version's `CHANGELOG.md` section, and `scripts/install.sh` attached.
Deployments pin a release and move only when their operator upgrades, so a
release is the unit operators trust; `master` between releases is not.

1. `sh scripts/release.sh prepare X.Y.Z` on an up-to-date `master`. It sets
   the version in every `package.json`, dates the Unreleased section, and
   pushes a `release/vX.Y.Z` branch. Open it as a pull request titled
   `Release vX.Y.Z` and merge it like any other.
2. `sh scripts/release.sh tag X.Y.Z-rc.1` on the squash commit. The release
   workflow re-runs the checks, verifies that the tag, the version fields and
   the changelog agree (`scripts/release-check.sh`), and publishes a
   pre-release. Deploy it to your own environment and use it.
3. `sh scripts/release.sh tag X.Y.Z` on the same commit, or on the squash
   commit of a fix. The workflow publishes it as the latest release.

Semantic versioning from the operator's side: a major version means they
must act (a configuration or migration change that is not automatic), a
minor one adds features, a patch fixes. A tag is never moved or deleted; a
bad release is followed by a patch, and the bad one is marked as a
pre-release so `latest` skips it. A tag ruleset on `v*` limits who can
create one.

## License

PhotonRelic is licensed under the Apache License, Version 2.0. By
contributing you agree that your contributions are licensed the same way
(section 5 of the license). You may add yourself to [AUTHORS](AUTHORS) in
your first pull request if you wish.

## Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
