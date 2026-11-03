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

You need Node 22.13 or later and pnpm (`corepack enable` picks the right
version from `package.json`).

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
- CI must pass: lint, typecheck, tests. Pull requests from forks skip one
  internal check that maintainers run themselves.
- Do not include deployment details (hostnames, account or database ids,
  Access tags) in code, tests or messages. Everything under `deploy/` except
  the example is ignored for that reason.

## License

PhotonRelic is licensed under the Apache License, Version 2.0. By
contributing you agree that your contributions are licensed the same way
(section 5 of the license). You may add yourself to [AUTHORS](AUTHORS) in
your first pull request if you wish.

## Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
