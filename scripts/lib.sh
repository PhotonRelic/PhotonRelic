#!/bin/sh
# Shared by the scripts in this directory; not run on its own.
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

# Credentials come from the environment, or from a .env in the directory the
# script is run from (never committed).
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ -f ./.env ]; then
  set -a
  . ./.env
  set +a
fi

need_credentials() {
  : "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (environment or ./.env)}"
  : "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID (environment or ./.env)}"
}

# The environment directory: an absolute path holding library.toml and/or resizer.toml.
env_dir() {
  d=$(CDPATH= cd -- "$1" 2>/dev/null && pwd) || { echo "no such directory: $1" >&2; exit 1; }
  [ -f "$d/library.toml" ] || [ -f "$d/resizer.toml" ] || {
    echo "$d has neither library.toml nor resizer.toml" >&2
    exit 1
  }
  printf '%s' "$d"
}

# cf METHOD PATH [JSON_BODY]  -> response body on stdout
cf() {
  if [ -n "${3:-}" ]; then
    curl -sS -X "$1" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' \
      "https://api.cloudflare.com/client/v4$2" --data "$3"
  else
    curl -sS -X "$1" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      "https://api.cloudflare.com/client/v4$2"
  fi
}

# json EXPR  -> evaluates a JS expression against the JSON on stdin (r = parsed body); exits 3 on null
json() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);const v=eval(process.argv[1]);if(v===undefined||v===null){process.exit(3)}process.stdout.write(String(v))})' "$1"
}

# ok RESPONSE  -> exits loudly unless the envelope says success
ok() {
  if [ "$(printf '%s' "$1" | json 'r.success' 2>/dev/null)" != "true" ]; then
    echo "Cloudflare API error:" >&2
    printf '%s\n' "$1" >&2
    exit 1
  fi
}

# toml KEY FILE  -> the first `KEY = "value"` in a wrangler.toml
toml() { sed -n "s/^$1 = \"\(.*\)\".*/\1/p" "$2" | head -n 1; }

# pass / fail / note  -> one line per check, in the shape preflight, verify and
# release-check share and AGENTS.md teaches agents to relay. fail takes the
# message and the fix.
PASS=0; FAILS=0
pass() { PASS=$((PASS + 1)); printf 'pass  %s\n' "$1"; }
fail() { FAILS=$((FAILS + 1)); printf 'FAIL  %s\n      fix: %s\n' "$1" "$2"; }
note() { printf 'note  %s\n' "$1"; }

# latest_stable_tag REPO  -> the newest vX.Y.Z tag of a remote URL or a local
# path, skipping release candidates; nothing when there is none. install.sh
# carries a copy, because it runs before any checkout exists.
latest_stable_tag() {
  git ls-remote --refs --tags -- "$1" 2>/dev/null \
    | sed -n 's|^[0-9a-f]*[[:space:]]*refs/tags/v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$|\1|p' \
    | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1 | sed 's/^./v&/'
}
