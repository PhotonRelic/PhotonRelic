# Security

PhotonRelic puts your images and their metadata on the public internet behind
Cloudflare Access and a public resizer, so we take reports seriously.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use one of these:

- **Private vulnerability report** on GitHub: open the repository's Security
  tab and choose *Report a vulnerability*. This is the preferred route; it
  gives a private thread and, when a fix ships, a published advisory with
  credit to you.
- **Email** [security@photonrelic.com](mailto:security@photonrelic.com).

Include what you found, how to reproduce it, and what you think the impact
is. You will get an acknowledgement within a few days. Fixes are published
as a new release with an advisory; please give us the chance to do that
before you publish details.

## What counts

Anything that lets someone read, change or delete images or metadata they
should not, bypass Cloudflare Access on the library, get the resizer to
serve keys outside `SERVED_PREFIXES`, run up an Images bill with off-menu
transformations, or execute code in a visitor's browser. Issues in Cloudflare
itself belong with [Cloudflare](https://www.cloudflare.com/.well-known/security.txt).

## Supported versions

The latest release and the `master` branch. Older releases get fixes only
when the change is small and safe to backport.

## Keeping your own deployment safe

The library verifies the Access JWT on every request and refuses to start
without `ACCESS_AUD`, so a misconfigured policy fails closed. Keep the
library's hostname behind Access, keep `.env` and `.dev.vars` out of version
control, and give deploy tokens only the permissions listed in
`.env.example`.
