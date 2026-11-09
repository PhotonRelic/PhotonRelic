#!/bin/sh
# Installs PhotonRelic into your Cloudflare account from one command: creates
# the private deployment repository, checks the account, provisions the
# resources, deploys both Workers and verifies the result.
#
#   sh install.sh [options]
#
# Run it from a download (every release attaches it) or from a checkout of
# PhotonRelic (scripts/install.sh). It asks for what it needs; every answer
# can be given as an option instead, so an agent can run it for you:
#
#   --dir <path>            the deployment repository to create (default ./photonrelic-deploy)
#   --name <env>            environment name: lowercase letters, digits, hyphens (default production)
#   --library-host <host>   the staff app's hostname, e.g. media-admin.example.com
#   --resizer-host <host>   the public image hostname, e.g. img.example.com
#   --account-id <id>       your Cloudflare account ID (32 hex characters)
#   --email-domains <list>  comma-separated email domains staff sign in with
#   --team-name <name>      Zero Trust team name, created if the account has none
#   --version <vX.Y.Z>      the release to install (default: the newest)
#   --source <url|path>     the repository to install from (default: the public project)
#   --yes                   skip the confirmations
#   --dry-run               stop after preflight; create nothing in the account
#
# The deploy token is read from CLOUDFLARE_API_TOKEN or asked for at a hidden
# prompt, written to <dir>/.env (never committed) and never printed. Nothing is
# installed on your machine: git, Node 22.13+, pnpm 9+ and curl must be there.
set -eu
UPSTREAM="https://github.com/PhotonRelic/PhotonRelic.git"
DIR=""; NAME=""; LIB_HOST=""; RES_HOST=""; ACCOUNT_ID=""; EMAIL_DOMAINS=""; TEAM_NAME=""
VERSION=""; SOURCE=""; YES=false; DRY_RUN=false; TMP=""; ECHO_OFF=false

usage() { sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
say() { printf '%s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }
cleanup() {
  [ "$ECHO_OFF" = false ] || ( stty echo </dev/tty ) 2>/dev/null || true
  [ -z "$TMP" ] || rm -rf "$TMP"
}
trap cleanup EXIT INT TERM HUP
have_tty() { ( : </dev/tty ) 2>/dev/null; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR=${2:?}; shift 2 ;;
    --name) NAME=${2:?}; shift 2 ;;
    --library-host) LIB_HOST=${2:?}; shift 2 ;;
    --resizer-host) RES_HOST=${2:?}; shift 2 ;;
    --account-id) ACCOUNT_ID=${2:?}; shift 2 ;;
    --email-domains) EMAIL_DOMAINS=${2:?}; shift 2 ;;
    --team-name) TEAM_NAME=${2:?}; shift 2 ;;
    --version) VERSION=${2:?}; shift 2 ;;
    --source) SOURCE=${2:?}; shift 2 ;;
    --yes) YES=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage ;;
    *) echo "install: unknown option $1" >&2; usage ;;
  esac
done

# ask VAR --flag "question" [default]  -> fills VAR from the terminal unless set
ask() {
  eval "cur=\${$1:-}"
  [ -z "$cur" ] || return 0
  have_tty || die "no terminal to ask for it: pass $2"
  if [ -n "${4:-}" ]; then printf '%s [%s]: ' "$3" "$4" >/dev/tty; else printf '%s: ' "$3" >/dev/tty; fi
  read -r ans </dev/tty || die "no answer; pass $2"
  [ -n "$ans" ] || ans=${4:-}
  eval "$1=\$ans"
}
# confirm "question"  -> continues on yes; --yes answers for you
confirm() {
  [ "$YES" = false ] || return 0
  have_tty || die "no terminal to confirm; pass --yes to proceed without asking"
  printf '%s [y/N]: ' "$1" >/dev/tty
  read -r ans </dev/tty || ans=""
  case "$ans" in y|Y|yes|YES) ;; *) say "stopped."; exit 1 ;; esac
}
# run_step "title" "resume command" cmd...  -> runs cmd; on failure says how to continue
run_step() {
  title=$1; resume=$2; shift 2
  say ""; say "== $title"
  if ! "$@"; then
    say ""
    say "install: $title failed. Fix what it reported, then continue with:"
    say "  cd $DIR && $resume"
    say "Running the installer again with the same options also continues from here."
    exit 1
  fi
}
# latest_stable_tag REPO  -> the newest vX.Y.Z tag, skipping release candidates (same as lib.sh)
latest_stable_tag() {
  git ls-remote --refs --tags -- "$1" 2>/dev/null \
    | sed -n 's|^[0-9a-f]*[[:space:]]*refs/tags/v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$|\1|p' \
    | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1 | sed 's/^./v&/'
}

say "PhotonRelic installer"
say ""
say "Before this runs, six things must be true in the Cloudflare dashboard"
say "(docs/deploy.md, Prerequisites, has the page for each):"
say "  1. the account is on the Workers Paid plan"
say "  2. R2 is enabled"
say "  3. Images is enabled"
say "  4. the domain the two hostnames are under is a zone in the account"
say "  5. Zero Trust is enabled, or you give --team-name and it is created"
say "  6. you have an API token with the deploy permissions (docs/deploy.md, Tokens)"
confirm "Are these in place?"

say ""; say "== This machine"
for t in git node pnpm curl; do command -v "$t" >/dev/null 2>&1 || die "$t is not installed"; done
nv=$(node --version | sed 's/^v//'); maj=${nv%%.*}; rest=${nv#*.}; min=${rest%%.*}
[ "$maj" -gt 22 ] || { [ "$maj" -eq 22 ] && [ "$min" -ge 13 ]; } || die "Node $nv is too old; 22.13 or later is needed"
pv=$(pnpm --version); [ "${pv%%.*}" -ge 9 ] || die "pnpm $pv is too old; 9 or later is needed (npm install -g pnpm@12)"
say "git, Node $nv, pnpm $pv, curl"

say ""; say "== What to install"
# Where the scripts run from, and what the deployment repository pins.
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || true)
CHECKOUT=""
if [ -n "$HERE" ] && [ -f "$HERE/init-deploy-repo.sh" ] && [ -f "$HERE/lib.sh" ] && git -C "$HERE" rev-parse --show-toplevel >/dev/null 2>&1; then
  CHECKOUT=$(git -C "$HERE" rev-parse --show-toplevel)
fi
SCRIPTS=""
if [ -z "$SOURCE" ] && [ -z "$VERSION" ] && [ -n "$CHECKOUT" ]; then
  # From a checkout: install what is checked out here.
  REF=$(git -C "$CHECKOUT" rev-parse HEAD)
  [ -z "$(git -C "$CHECKOUT" status --porcelain)" ] || say "note: this checkout has uncommitted changes; they are not part of what is installed"
  if origin=$(git -C "$CHECKOUT" remote get-url origin 2>/dev/null) && [ -n "$(git -C "$CHECKOUT" branch -r --contains "$REF" 2>/dev/null)" ]; then
    SOURCE=$origin
  else
    SOURCE=$CHECKOUT
    say "note: this commit is not on a remote, so the deployment repository will point at $CHECKOUT; move it with --source later"
  fi
  SCRIPTS="$CHECKOUT/scripts"
  say "this checkout, $(git -C "$CHECKOUT" describe --tags --always 2>/dev/null) from $SOURCE"
else
  [ -n "$SOURCE" ] || SOURCE=$UPSTREAM
  if [ -n "$VERSION" ]; then
    REF=$VERSION
  else
    case "$SOURCE" in
      /*|./*|../*) REF=$(git -C "$SOURCE" rev-parse HEAD 2>/dev/null) || die "$SOURCE is not a git checkout" ;;
      *) REF=$(latest_stable_tag "$SOURCE"); [ -n "$REF" ] || die "$SOURCE has no release tags yet; pass --version <tag> or --source <path to a checkout>" ;;
    esac
  fi
  case "$REF" in v*) say "PhotonRelic $REF from $SOURCE" ;; *) say "PhotonRelic commit $(printf %s "$REF" | cut -c1-7) from $SOURCE" ;; esac
fi

[ -n "$DIR" ] || DIR=./photonrelic-deploy
ask NAME --name "Environment name" production
case "$NAME" in *[!a-z0-9-]*|-*|*-|"") die "--name must be lowercase letters, digits and hyphens" ;; esac
ask LIB_HOST --library-host "Library hostname (staff sign in here), e.g. media-admin.example.com"
ask RES_HOST --resizer-host "Resizer hostname (public images), e.g. img.example.com"
for h in "$LIB_HOST" "$RES_HOST"; do case "$h" in *://*|*/*|*example.com|"") die "$h is not a bare hostname of yours" ;; esac; done
[ "$LIB_HOST" != "$RES_HOST" ] || die "the library and the resizer need different hostnames"

RESUMING=false
if [ -e "$DIR/photonrelic/.git" ] && [ -d "$DIR/environments/$NAME" ]; then
  RESUMING=true
  say "$DIR already holds environment $NAME; continuing with it"
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die "$DIR exists and is not empty, and is not a deployment repository for $NAME"
fi

if [ "$RESUMING" = false ]; then
  if [ -z "$SCRIPTS" ]; then
    TMP=$(mktemp -d "${TMPDIR:-/tmp}/photonrelic.XXXXXX")
    say "fetching $REF"
    if ! git clone -q --depth 1 --branch "$REF" -- "$SOURCE" "$TMP/src" 2>/dev/null; then
      git clone -q -- "$SOURCE" "$TMP/src" || die "could not clone $SOURCE"
      git -C "$TMP/src" checkout -q "$REF" || die "$REF is not in $SOURCE"
    fi
    SCRIPTS="$TMP/src/scripts"
  fi
  [ -f "$SCRIPTS/init-deploy-repo.sh" ] || die "$REF has no scripts/init-deploy-repo.sh; it predates the installer. Pass a newer --version"
  say ""; say "== Deployment repository at $DIR"
  sh "$SCRIPTS/init-deploy-repo.sh" "$DIR" --name "$NAME" --library-host "$LIB_HOST" --resizer-host "$RES_HOST" --source "$SOURCE" --ref "$REF"
fi
DIR=$(CDPATH= cd -- "$DIR" && pwd)
cd "$DIR"

say ""; say "== Credentials"
if [ -f .env ]; then
  say ".env exists; using it"
else
  ask ACCOUNT_ID --account-id "Cloudflare account ID (32 hex characters, on the account's home page)"
  case "$ACCOUNT_ID" in *[!0-9a-f]*|"") die "the account ID is 32 lowercase hex characters" ;; esac
  [ ${#ACCOUNT_ID} -eq 32 ] || die "the account ID is 32 hex characters"
  ask EMAIL_DOMAINS --email-domains "Email domains staff sign in with, comma-separated"
  case "$EMAIL_DOMAINS" in *[!a-z0-9.,-]*|"") die "--email-domains is a comma-separated list of lowercase domains" ;; esac
  if [ -z "$TEAM_NAME" ] && [ "$YES" = false ] && have_tty; then
    printf 'Zero Trust team name to create (leave empty if the account already has one): ' >/dev/tty
    read -r TEAM_NAME </dev/tty || TEAM_NAME=""
  fi
  case "$TEAM_NAME" in *[!a-z0-9-]*) die "--team-name is lowercase letters, digits and hyphens" ;; esac
  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    have_tty || die "no terminal to ask for the token: set CLOUDFLARE_API_TOKEN in the environment"
    printf 'Deploy token (not shown; permissions in docs/deploy.md, Tokens): ' >/dev/tty
    ECHO_OFF=true; stty -echo </dev/tty
    read -r CLOUDFLARE_API_TOKEN </dev/tty || CLOUDFLARE_API_TOKEN=""
    stty echo </dev/tty; ECHO_OFF=false
    printf '\n' >/dev/tty
  else
    say "token from CLOUDFLARE_API_TOKEN"
  fi
  case "$CLOUDFLARE_API_TOKEN" in *[!A-Za-z0-9_-]*|"") die "that does not look like an API token" ;; esac
  (
    umask 077
    {
      printf '# Credentials for this deployment repository. Never committed. See .env.example for the optional tokens.\n'
      printf 'CLOUDFLARE_API_TOKEN=%s\n' "$CLOUDFLARE_API_TOKEN"
      printf 'CLOUDFLARE_ACCOUNT_ID=%s\n' "$ACCOUNT_ID"
      printf 'ACCESS_ALLOWED_EMAIL_DOMAINS=%s\n' "$EMAIL_DOMAINS"
      [ -z "$TEAM_NAME" ] || printf 'ACCESS_TEAM_NAME=%s\n' "$TEAM_NAME"
    } > .env
  )
  say ".env written (mode 600)"
fi
# From here on the scripts read .env themselves (lib.sh loads it only when the
# token is not already in the environment), so the file is the one source.
unset CLOUDFLARE_API_TOKEN

setup() { git submodule update --init -q && pnpm --dir photonrelic install --frozen-lockfile; }
run_step "Dependencies" "pnpm run setup" setup
run_step "Preflight" "pnpm run preflight $NAME" sh scripts/preflight.sh "$NAME"

if [ "$DRY_RUN" = true ]; then
  say ""
  say "dry run: nothing was created in the account. To continue, in $DIR:"
  say "  pnpm run provision $NAME && pnpm run check && pnpm run deploy $NAME && pnpm run verify $NAME"
  exit 0
fi

say ""
say "Provisioning creates in your account: the Access application for $LIB_HOST,"
say "the bucket photonrelic-$NAME-media, the database photonrelic-$NAME${TEAM_NAME:+, and the Zero Trust team $TEAM_NAME}."
say "Deploying then adds the Workers and the custom domains $LIB_HOST and $RES_HOST."
confirm "Create them now?"
run_step "Provision" "pnpm run provision $NAME" sh scripts/provision.sh "$NAME"
run_step "Build" "pnpm run check" sh scripts/deploy.sh "$NAME" --dry-run
run_step "Deploy" "pnpm run deploy $NAME" sh scripts/deploy.sh "$NAME"

say ""; say "== Verify"
if ! out=$(sh scripts/verify.sh "$NAME" 2>&1); then
  printf '%s\n' "$out"
  if printf '%s' "$out" | grep -q 'nothing answered'; then
    say "the hostnames are not answering yet; waiting a minute"
    sleep 60
    sh scripts/verify.sh "$NAME" || { say ""; say "install: verify still fails. Fix what it reported, then: cd $DIR && pnpm run verify $NAME"; exit 1; }
  else
    say ""; say "install: verify failed. Fix what it reported, then: cd $DIR && pnpm run verify $NAME"; exit 1
  fi
else
  printf '%s\n' "$out"
fi

say ""
say "installed. Sign in at https://$LIB_HOST/ with an address on $EMAIL_DOMAINS and upload a folder."
say "Then commit the deployment repository and push it somewhere private:"
say "  cd $DIR && git add -A && git commit -m \"$NAME: PhotonRelic deployed\""
say "After the first upload: pnpm run verify $NAME --key <a filed key> confirms resizing."
