#!/bin/sh
# Applies the library's D1 migrations and deploys whichever Workers the
# environment directory configures (resizer.toml, library.toml). Pass
# --dry-run to build without credentials or any change to Cloudflare.
#
#   sh scripts/deploy.sh deploy/<name> [--dry-run]
set -eu
. "$(dirname -- "$0")/lib.sh"
ENV_DIR=$(env_dir "${1:?usage: deploy.sh <environment directory> [--dry-run]}")
ENV_NAME=$(basename -- "$ENV_DIR")
DRY="${2:-}"
LIB="$ENV_DIR/library.toml"
RES="$ENV_DIR/resizer.toml"

if [ -f "$LIB" ] && grep -q '= "REPLACE_' "$LIB"; then
  echo "$LIB still has REPLACE_ placeholders; run scripts/provision.sh first" >&2
  [ "$DRY" = "--dry-run" ] || exit 1
fi
[ -d "$ROOT/node_modules" ] || pnpm --dir "$ROOT" install --frozen-lockfile

# Each Worker's own wrangler, from its package. Wrangler resolves `main`,
# `assets.directory` and `migrations_dir` relative to the config file.
wr() { pkg=$1; shift; pnpm --dir "$ROOT/workers/$pkg" exec wrangler "$@"; }

if [ "$DRY" = "--dry-run" ]; then
  out="$ROOT/.wrangler/dry-run/$ENV_NAME"
  [ ! -f "$RES" ] || wr resizer deploy -c "$RES" --dry-run --outdir "$out/resizer"
  [ ! -f "$LIB" ] || wr library deploy -c "$LIB" --dry-run --outdir "$out/library"
  exit 0
fi
need_credentials
[ ! -f "$LIB" ] || wr library d1 migrations apply DB --remote -c "$LIB"
[ ! -f "$RES" ] || wr resizer deploy -c "$RES"
[ ! -f "$LIB" ] || wr library deploy -c "$LIB"
# Optional: the token the library reads usage with (Account Analytics Read),
# from .env. Putting a secret replaces it, so this is safe to run every time;
# without ANALYTICS_TOKEN nothing is put and the library says "not configured".
if [ -f "$LIB" ] && [ -n "${ANALYTICS_TOKEN:-}" ]; then
  printf '%s' "$ANALYTICS_TOKEN" | wr library secret put ANALYTICS_TOKEN -c "$LIB"
fi
