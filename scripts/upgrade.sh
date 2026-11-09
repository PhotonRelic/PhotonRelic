#!/bin/sh
# Moves a deployment to another PhotonRelic release: shows what changed, moves
# the submodule's pin, deploys, verifies, and commits the pin. Run from a
# deployment repository, through its wrapper or directly:
#
#   pnpm run upgrade-photonrelic <env> [vX.Y.Z] [options]
#   sh photonrelic/scripts/upgrade.sh environments/<env> [vX.Y.Z] [options]
#
# Without a version, the newest release; release candidates are skipped unless
# named. A target older than the current pin is refused without
# --allow-downgrade, because database migrations never run backwards. --yes
# skips the confirmation. Nothing changes until you confirm.
set -eu
# The checkout below replaces this very file while the shell is still reading
# it, so the script first copies itself and runs the copy.
case "${1:-}" in
  --reexec) ORIG=$2; shift 2; trap 'rm -f -- "$0"' EXIT ;;
  *) tmp=$(mktemp "${TMPDIR:-/tmp}/photonrelic-upgrade.XXXXXX"); cat "$0" > "$tmp"; exec sh "$tmp" --reexec "$0" "$@" ;;
esac
. "$(dirname -- "$ORIG")/lib.sh"
ROOT=$(CDPATH= cd -- "$(dirname -- "$ORIG")/.." && pwd)
usage() { sed -n '2,12p' "$ORIG" | sed 's/^# \{0,1\}//' >&2; exit 2; }
die() { echo "upgrade: $*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

ENV_ARG=""; TARGET=""; DOWNGRADE=false; YES=false
while [ $# -gt 0 ]; do
  case "$1" in
    --allow-downgrade) DOWNGRADE=true; shift ;;
    --yes) YES=true; shift ;;
    -h|--help) usage ;;
    -*) echo "upgrade: unknown option $1" >&2; usage ;;
    *) if [ -z "$ENV_ARG" ]; then ENV_ARG=$1; else TARGET=$1; fi; shift ;;
  esac
done
[ -n "$ENV_ARG" ] || usage
ENV_DIR=$(env_dir "$ENV_ARG")
ENVNAME=$(basename "$ENV_DIR")
SUB=$ROOT
REPO=$(git -C "$ENV_DIR" rev-parse --show-toplevel 2>/dev/null) || die "$ENV_DIR is not inside a git repository"
need_credentials

[ -z "$(git -C "$REPO" status --porcelain --ignore-submodules=dirty)" ] || die "the deployment repository has uncommitted changes; commit or stash them first"
[ -z "$(git -C "$SUB" status --porcelain)" ] || die "the PhotonRelic submodule has local changes; it should be a clean checkout of a release"

say "== Releases"
git -C "$SUB" fetch -q --tags origin || die "could not fetch tags from the submodule's origin"
stable=$(git -C "$SUB" tag -l 'v[0-9]*' | sed 's/^v//' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1,1n -k2,2n -k3,3n || true)
if [ -z "$stable" ]; then
  die "the submodule's origin has no release tags. A fork or mirror needs the project's tags pushed to it:
  git fetch https://github.com/PhotonRelic/PhotonRelic.git --tags && git push <your remote> --tags"
fi
[ -n "$TARGET" ] || TARGET="v$(printf '%s\n' "$stable" | tail -n 1)"
git -C "$SUB" rev-parse -q --verify "refs/tags/$TARGET" >/dev/null || die "$TARGET is not a release tag"
CUR_SHA=$(git -C "$SUB" rev-parse HEAD)
TGT_SHA=$(git -C "$SUB" rev-parse "$TARGET^{commit}")
CURRENT=$(git -C "$SUB" describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || true)
if [ "$CUR_SHA" = "$TGT_SHA" ]; then say "already at $TARGET"; exit 0; fi
say "current: ${CURRENT:-no release} ($(printf %s "$CUR_SHA" | cut -c1-7))"
say "target:  $TARGET ($(printf %s "$TGT_SHA" | cut -c1-7))"
if git -C "$SUB" merge-base --is-ancestor "$TGT_SHA" "$CUR_SHA"; then
  [ "$DOWNGRADE" = true ] || die "$TARGET is older than the current pin. Migrations never run backwards; pass --allow-downgrade if you mean it"
  say "note: downgrading; the database keeps every migration already applied"
fi

say ""; say "== What changes"
# The target's changelog, from its newest section down to the current release.
git -C "$SUB" show "$TARGET:CHANGELOG.md" 2>/dev/null \
  | awk -v stop="## [${CURRENT#v}] - " '
      /^## \[Unreleased\]/ { skip = 1; next }
      /^## \[/ { if (stop != "## [] - " && index($0, stop) == 1) exit; skip = 0 }
      !skip && started { print }
      /^## \[/ && !skip { started = 1; print }
    ' | sed -n '/[^[:space:]]/,$p' || say "(no CHANGELOG.md at $TARGET)"

others=$(ls "$REPO/environments" 2>/dev/null | grep -v "^$ENVNAME\$" || true)
if [ -n "$others" ]; then
  say ""
  say "note: the submodule is shared by every environment here; after this, deploy the others too:"
  for o in $others; do say "  pnpm run deploy $o && pnpm run verify $o"; done
fi

if [ "$YES" = false ]; then
  ( : </dev/tty ) 2>/dev/null || die "no terminal to confirm; pass --yes"
  printf '\nMove %s to %s and deploy it? [y/N]: ' "$ENVNAME" "$TARGET" >/dev/tty
  read -r ans </dev/tty || ans=""
  case "$ans" in y|Y|yes|YES) ;; *) say "stopped."; exit 1 ;; esac
fi

undo() {
  say ""
  say "upgrade: $1 failed. The submodule is at $TARGET and the pin is not committed. Either fix what it reported and run"
  say "  pnpm run deploy $ENVNAME && pnpm run verify $ENVNAME && git add photonrelic && git commit -m \"$ENVNAME: PhotonRelic $TARGET\""
  say "or go back to where you were:"
  say "  git -C photonrelic checkout $CUR_SHA && pnpm run setup"
  exit 1
}
say ""; say "== Checkout $TARGET"
git -C "$SUB" checkout -q "$TARGET"
pnpm --dir "$SUB" install --frozen-lockfile || undo "installing dependencies"
say ""; say "== Build"
sh "$SUB/scripts/deploy.sh" "$ENV_DIR" --dry-run || undo "the build"
say ""; say "== Deploy"
sh "$SUB/scripts/deploy.sh" "$ENV_DIR" || undo "the deploy"
say ""; say "== Verify"
if ! sh "$SUB/scripts/verify.sh" "$ENV_DIR"; then
  say ""
  say "upgrade: $TARGET is deployed but verify reported failures. Fix them, run pnpm run verify $ENVNAME, then commit the pin:"
  say "  git add photonrelic && git commit -m \"$ENVNAME: PhotonRelic $TARGET\""
  exit 1
fi
if git -C "$REPO" add -- "$SUB" && git -C "$REPO" commit -q -m "$ENVNAME: PhotonRelic $TARGET"; then
  say ""; say "done: $ENVNAME is on $TARGET and the pin is committed."
else
  say ""; say "done: $ENVNAME is on $TARGET. Commit the pin yourself:"
  say "  git add photonrelic && git commit -m \"$ENVNAME: PhotonRelic $TARGET\""
fi
