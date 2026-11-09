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
#   --commit <sha>          the full commit id that release must be (from its release notes)
#   --source <url|path>     the repository to install from (default: the public project;
#                           https://, ssh://, git@host: or a local path)
#   --yes                   skip the confirmations
#   --dry-run               stop after preflight; create nothing in the account
#
# The deploy token is read from CLOUDFLARE_API_TOKEN or asked for at a hidden
# prompt, written to <dir>/.env (never committed) and never printed.
#
# Or let the installer mint the tokens. Give it one bootstrap token, created
# under Manage Account → Account API Tokens with the single permission Account
# → Account API Tokens → Edit on the one account and a day's expiry, at a
# hidden prompt or in CLOUDFLARE_BOOTSTRAP_TOKEN. It creates the deploy token
# itself, narrowed to your hostnames' zones, plus whichever optional ones you
# ask for. A token made under My Profile is refused. The bootstrap token is
# kept out of every other process this runs.
#
#   --mint                  mint the deploy token from a bootstrap token
#   --usage                 also a token for usage counts
#   --purge                 also a token for cache purge (sets CF_ZONE_ID too)
#   --masters               also the R2 key pair for masters in the bucket
#   --retire-bootstrap      delete the bootstrap token when the install is done
#
# Nothing is installed globally on your machine (dependencies go under the new
# repository): git, Node 22.13+, pnpm 10+ and curl 7.55+ must be there.
set -eu
UPSTREAM="https://github.com/PhotonRelic/PhotonRelic.git"
DIR=""; NAME=""; LIB_HOST=""; RES_HOST=""; ACCOUNT_ID=""; EMAIL_DOMAINS=""; TEAM_NAME=""
VERSION=""; SOURCE=""; COMMIT=""; YES=false; DRY_RUN=false; TMP=""; ECHO_OFF=false
USAGE=false; PURGE=false; MASTERS=false; RETIRE=false; MINT=false; BOOTSTRAP_RETIRED=false
# The bootstrap token lives in this shell variable only; it is removed from the
# environment at once so no child process but the mint calls can see it.
BOOT=${CLOUDFLARE_BOOTSTRAP_TOKEN:-}
unset CLOUDFLARE_BOOTSTRAP_TOKEN

usage() { sed -n '2,44p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
say() { printf '%s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; command -v bootstrap_reminder >/dev/null 2>&1 && bootstrap_reminder; exit 1; }
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
    --commit) COMMIT=${2:?}; shift 2 ;;
    --source) SOURCE=${2:?}; shift 2 ;;
    --yes) YES=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --mint) MINT=true; shift ;;
    --usage) USAGE=true; MINT=true; shift ;;
    --purge) PURGE=true; MINT=true; shift ;;
    --masters) MASTERS=true; MINT=true; shift ;;
    --retire-bootstrap) RETIRE=true; MINT=true; shift ;;
    -h|--help) usage ;;
    *) echo "install: unknown option $1" >&2; usage ;;
  esac
done
[ -z "$BOOT" ] || MINT=true
case "$COMMIT" in ""|????????????????????????????????????????) ;; *) die "--commit takes the full 40-character commit id from the release notes" ;; esac
case "$COMMIT" in *[!0-9a-f]*) die "--commit takes a hexadecimal commit id" ;; esac

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
    bootstrap_reminder
    exit 1
  fi
}
# bootstrap_reminder -> the bootstrap token can mint anything; never let it be forgotten
bootstrap_reminder() {
  [ "$MINT" = true ] && [ "$BOOTSTRAP_RETIRED" = false ] || return 0
  say ""
  say "The bootstrap token is still valid and can create any token in the account. When you are done with it, in ${DIR:-the deployment repository}:"
  say "  read -rs CLOUDFLARE_BOOTSTRAP_TOKEN && export CLOUDFLARE_BOOTSTRAP_TOKEN && sh photonrelic/scripts/mint-tokens.sh environments/${NAME:-<env>} --retire-bootstrap"
  say "(the token is typed without echo and stays out of your shell history), or delete it where you created it"
  say "(Manage Account → Account API Tokens)."
}
# mint_step ARGS... -> runs mint-tokens.sh with the bootstrap token in its environment alone
mint_step() { CLOUDFLARE_BOOTSTRAP_TOKEN="$BOOT" sh photonrelic/scripts/mint-tokens.sh "$@"; }
# is_hostname NAME -> a bare lowercase hostname with at least two labels (same as lib.sh)
is_hostname() { printf '%s' "$1" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'; }
# is_git_source URL -> https://, ssh://, git@host:path or a local path; nothing plaintext (same as lib.sh)
is_git_source() { case "$1" in https://*|ssh://*|/*|./*|../*|git@*:*) return 0 ;; *) return 1 ;; esac; }
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
pv=$(pnpm --version); [ "${pv%%.*}" -ge 10 ] || die "pnpm $pv is too old; 10 or later is needed (npm install -g pnpm@12): it enforces the list of dependencies allowed to run install scripts"
cv=$(curl --version | sed -n '1s/^curl \([0-9]*\)\.\([0-9]*\).*/\1 \2/p')
{ [ "${cv% *}" -gt 7 ] || { [ "${cv% *}" -eq 7 ] && [ "${cv#* }" -ge 55 ]; }; } 2>/dev/null || die "curl is older than 7.55; the scripts hand it the token on stdin, which older versions cannot read"
say "git, Node $nv, pnpm $pv, curl $(curl --version | sed -n '1s/^curl \([0-9.]*\).*/\1/p')"

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
  is_git_source "$SOURCE" || die "--source must be https://, ssh://, git@host:path or a local path; $SOURCE would move code in the clear"
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
for h in "$LIB_HOST" "$RES_HOST"; do
  case "$h" in example.com|*.example.com) die "$h is the documentation's placeholder, not a hostname of yours" ;; esac
  is_hostname "$h" || die "$h is not a bare lowercase hostname (letters, digits, hyphens and dots, at least two labels)"
done
[ "$LIB_HOST" != "$RES_HOST" ] || die "the library and the resizer need different hostnames"

RESUMING=false
if [ -e "$DIR/photonrelic/.git" ] && [ -d "$DIR/environments/$NAME" ]; then
  RESUMING=true
  say "$DIR already holds environment $NAME; continuing with it"
  if [ -n "$COMMIT" ]; then
    got=$(git -C "$DIR/photonrelic" rev-parse HEAD 2>/dev/null || true)
    [ "$got" = "$COMMIT" ] || die "the repository's PhotonRelic checkout is commit ${got:-unknown}, not the $COMMIT you asked for"
  fi
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die "$DIR exists and is not empty, and is not a deployment repository for $NAME"
fi

if [ "$RESUMING" = false ]; then
  if [ -z "$SCRIPTS" ]; then
    TMP=$(mktemp -d "${TMPDIR:-/tmp}/photonrelic.XXXXXX")
    say "fetching $REF"
    if ! git -c transfer.fsckObjects=true clone -q --depth 1 --branch "$REF" -- "$SOURCE" "$TMP/src" 2>/dev/null; then
      git -c transfer.fsckObjects=true clone -q -- "$SOURCE" "$TMP/src" || die "could not clone $SOURCE"
      git -C "$TMP/src" checkout -q "$REF" || die "$REF is not in $SOURCE"
    fi
    if [ -n "$COMMIT" ]; then
      got=$(git -C "$TMP/src" rev-parse HEAD)
      [ "$got" = "$COMMIT" ] || die "$REF at $SOURCE is commit $got, not the $COMMIT you asked for. The tag may have been moved; check the release notes before going on"
      say "commit $COMMIT confirmed"
    fi
    SCRIPTS="$TMP/src/scripts"
  fi
  [ -f "$SCRIPTS/init-deploy-repo.sh" ] || die "$REF has no scripts/init-deploy-repo.sh; it predates the installer. Pass a newer --version"
  say ""; say "== Deployment repository at $DIR"
  sh "$SCRIPTS/init-deploy-repo.sh" "$DIR" --name "$NAME" --library-host "$LIB_HOST" --resizer-host "$RES_HOST" --source "$SOURCE" --ref "$REF" ${COMMIT:+--commit "$COMMIT"}
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
  if [ "$MINT" = true ]; then
    say "the deploy token will be minted from the bootstrap token"
    CLOUDFLARE_API_TOKEN=""
    if [ -z "$BOOT" ]; then
      have_tty || die "no terminal to ask for the bootstrap token: set CLOUDFLARE_BOOTSTRAP_TOKEN in the environment (read -rs CLOUDFLARE_BOOTSTRAP_TOKEN && export CLOUDFLARE_BOOTSTRAP_TOKEN keeps it out of your history)"
      printf 'Bootstrap token (not shown; an account-owned token from Manage Account → Account API Tokens with Account API Tokens → Edit): ' >/dev/tty
      ECHO_OFF=true; stty -echo </dev/tty
      read -r BOOT </dev/tty || BOOT=""
      stty echo </dev/tty; ECHO_OFF=false
      printf '\n' >/dev/tty
      case "$BOOT" in *[!A-Za-z0-9_-]*|"") die "that does not look like an API token" ;; esac
    fi
  elif [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    have_tty || die "no terminal to ask for the token: set CLOUDFLARE_API_TOKEN in the environment"
    printf 'Deploy token (not shown; permissions in docs/deploy.md, Tokens): ' >/dev/tty
    ECHO_OFF=true; stty -echo </dev/tty
    read -r CLOUDFLARE_API_TOKEN </dev/tty || CLOUDFLARE_API_TOKEN=""
    stty echo </dev/tty; ECHO_OFF=false
    printf '\n' >/dev/tty
  else
    say "token from CLOUDFLARE_API_TOKEN"
  fi
  [ "$MINT" = true ] || case "$CLOUDFLARE_API_TOKEN" in *[!A-Za-z0-9_-]*|"") die "that does not look like an API token" ;; esac
  (
    umask 077
    {
      printf '# Credentials for this deployment repository. Never committed. See .env.example for the optional tokens.\n'
      [ -z "$CLOUDFLARE_API_TOKEN" ] || printf 'CLOUDFLARE_API_TOKEN=%s\n' "$CLOUDFLARE_API_TOKEN"
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
MINT_ARGS=""
if [ "$MINT" = true ]; then
  [ -f photonrelic/scripts/mint-tokens.sh ] || die "this release has no scripts/mint-tokens.sh; install a newer one, or set CLOUDFLARE_API_TOKEN yourself"
  if [ "$MINT" = true ] && [ -z "$BOOT" ] && [ -f .env ] && grep -Eq '^CLOUDFLARE_API_TOKEN=.+' .env; then
    say "the deploy token is already in .env; nothing to mint"
  else
    [ -n "$BOOT" ] || die "no bootstrap token: pass it at the prompt, or set CLOUDFLARE_BOOTSTRAP_TOKEN"
    $USAGE && MINT_ARGS="$MINT_ARGS --usage"; $PURGE && MINT_ARGS="$MINT_ARGS --purge"
    # shellcheck disable=SC2086
    run_step "Tokens" "read -rs CLOUDFLARE_BOOTSTRAP_TOKEN && export CLOUDFLARE_BOOTSTRAP_TOKEN && sh photonrelic/scripts/mint-tokens.sh environments/$NAME --deploy$MINT_ARGS" \
      mint_step "environments/$NAME" --deploy $MINT_ARGS
  fi
fi
run_step "Preflight" "pnpm run preflight $NAME" sh scripts/preflight.sh "$NAME"

if [ "$DRY_RUN" = true ]; then
  say ""
  if [ "$MINT" = true ]; then say "dry run: nothing was created in the account except the tokens, now in .env. To continue, in $DIR:"
  else say "dry run: nothing was created in the account. To continue, in $DIR:"; fi
  say "  pnpm run provision $NAME && pnpm run check && pnpm run deploy $NAME && pnpm run verify $NAME"
  bootstrap_reminder
  exit 0
fi

say ""
say "Provisioning creates in your account: the Access application for $LIB_HOST,"
say "the bucket photonrelic-$NAME-media, the database photonrelic-$NAME${TEAM_NAME:+, and the Zero Trust team $TEAM_NAME}."
say "Deploying then adds the Workers and the custom domains $LIB_HOST and $RES_HOST."
confirm "Create them now?"
run_step "Provision" "pnpm run provision $NAME" sh scripts/provision.sh "$NAME"
if [ "$MINT" = true ] && [ "$MASTERS" = true ]; then
  run_step "Masters token" "read -rs CLOUDFLARE_BOOTSTRAP_TOKEN && export CLOUDFLARE_BOOTSTRAP_TOKEN && sh photonrelic/scripts/mint-tokens.sh environments/$NAME --masters" \
    mint_step "environments/$NAME" --masters
fi
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

if [ "$MINT" = true ] && [ "$RETIRE" = true ] && [ -n "$BOOT" ]; then
  say ""
  if mint_step "environments/$NAME" --retire-bootstrap | grep -q '^   deleted'; then BOOTSTRAP_RETIRED=true
  else say "install: the bootstrap token could not be deleted"; fi
fi

say ""
say "installed. Sign in at https://$LIB_HOST/ with an address on $EMAIL_DOMAINS and upload a folder."
say "Then commit the deployment repository and push it somewhere private:"
say "  cd $DIR && git add -A && git commit -m \"$NAME: PhotonRelic deployed\""
say "After the first upload: pnpm run verify $NAME --key <a filed key> confirms resizing."
bootstrap_reminder
