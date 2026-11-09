#!/bin/sh
# Applies the library's D1 migrations and deploys whichever Workers the
# environment directory configures (resizer.toml, library.toml). Pass
# --dry-run to build without credentials or any change to Cloudflare.
#
#   sh scripts/deploy.sh deploy/<name> [--dry-run]
set -eu
. "$(dirname -- "$0")/lib.sh"
usage() { sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
[ $# -ge 1 ] && [ $# -le 2 ] || usage
ENV_DIR=$(env_dir "$1")
ENV_NAME=$(basename -- "$ENV_DIR")
case "${2:-}" in ""|--dry-run) DRY="${2:-}" ;; *) echo "deploy: unknown option $2 (only --dry-run is accepted)" >&2; usage ;; esac
LIB="$ENV_DIR/library.toml"
RES="$ENV_DIR/resizer.toml"

for f in "$LIB" "$RES"; do
  if [ -f "$f" ] && grep -q '= "REPLACE_' "$f"; then
    echo "$f still has REPLACE_ placeholders; run scripts/provision.sh first" >&2
    [ "$DRY" = "--dry-run" ] || exit 1
  fi
done
# The library's only unauthenticated mode is local development. A deployed
# config must name an Access audience and must not call itself local.
if [ -f "$LIB" ]; then
  if grep -Eq '^ENVIRONMENT = "local"' "$LIB"; then
    echo "$LIB sets ENVIRONMENT = \"local\": that is the development mode with no login; a deployment must not use it" >&2; exit 1
  fi
  if ! grep -Eq '^ACCESS_AUD = "' "$LIB"; then
    echo "$LIB has no ACCESS_AUD line: the library must be behind Cloudflare Access; copy deploy/example/library.toml and run scripts/provision.sh" >&2; exit 1
  fi
fi
[ -d "$ROOT/node_modules" ] || pnpm --dir "$ROOT" install --frozen-lockfile

# Each Worker's own wrangler, from its package. Wrangler resolves `main`,
# `assets.directory` and `migrations_dir` relative to the config file. It gets
# the credentials, and only those, through its environment.
wr() { pkg=$1; shift; wrangler_env pnpm --dir "$ROOT/workers/$pkg" exec wrangler "$@"; }

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
# The cache purge token, when .env has one: stored as the library Worker's
# secret after the deploy (the Worker must exist first). Putting the same value
# again is harmless, so this runs every time; without one, nothing changes.
if [ -f "$LIB" ] && [ -n "${CACHE_PURGE_TOKEN:-}" ]; then
  printf '%s' "$CACHE_PURGE_TOKEN" | wr library secret put CACHE_PURGE_TOKEN -c "$LIB"
fi
# The R2 token that signs master uploads (Object Read & Write on the one bucket),
# when .env has it: both halves as library secrets, every deploy. One half
# alone is a mistake, and the Worker refuses to start on it, so stop here.
if [ -f "$LIB" ] && { [ -n "${R2_ACCESS_KEY_ID:-}" ] || [ -n "${R2_SECRET_ACCESS_KEY:-}" ]; }; then
  : "${R2_ACCESS_KEY_ID:?set R2_ACCESS_KEY_ID with R2_SECRET_ACCESS_KEY}"
  : "${R2_SECRET_ACCESS_KEY:?set R2_SECRET_ACCESS_KEY with R2_ACCESS_KEY_ID}"
  printf '%s' "$R2_ACCESS_KEY_ID" | wr library secret put R2_ACCESS_KEY_ID -c "$LIB"
  printf '%s' "$R2_SECRET_ACCESS_KEY" | wr library secret put R2_SECRET_ACCESS_KEY -c "$LIB"
fi
