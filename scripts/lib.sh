#!/bin/sh
# Shared by the scripts in this directory; not run on its own.
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

# Credentials come from the environment, or from a .env in the directory the
# script is run from (never committed). The file is read line by line as
# KEY=VALUE, never executed, and the values become plain shell variables:
# nothing exports them, so child processes (pnpm install, git, node) never see
# them. wrangler gets the two it needs through wrangler_env below. A variable
# already in the environment wins over the file.
load_env() {
  [ -f "$1" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    key=${line%%=*}; val=${line#*=}
    case "$key" in [A-Z_]*) ;; *) continue ;; esac
    case "$key" in *[!A-Z0-9_]*) continue ;; esac
    case "$val" in \"*\") val=${val#\"}; val=${val%\"} ;; \'*\') val=${val#\'}; val=${val%\'} ;; esac
    eval "cur=\${$key:-}"
    [ -n "$cur" ] || eval "$key=\$val"
  done < "$1"
}
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || load_env ./.env

need_credentials() {
  : "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (environment or ./.env)}"
  : "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID (environment or ./.env)}"
}

# wrangler_env CMD...  -> runs a command with only the two variables wrangler
# needs in its environment, when they are set (a dry run needs neither).
wrangler_env() {
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
    env CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}" "$@"
  else
    "$@"
  fi
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

# cf_as TOKEN METHOD PATH [JSON_BODY]  -> response body on stdout. The token
# reaches curl through stdin (-H @-), never on the command line, so it is not
# in the process list. Needs curl 7.55 or later; preflight checks that.
cf_as() {
  if [ -n "${4:-}" ]; then
    printf 'Authorization: Bearer %s\n' "$1" | curl -sS -X "$2" -H @- -H 'Content-Type: application/json' \
      "https://api.cloudflare.com/client/v4$3" --data "$4"
  else
    printf 'Authorization: Bearer %s\n' "$1" | curl -sS -X "$2" -H @- "https://api.cloudflare.com/client/v4$3"
  fi
}
# cf METHOD PATH [JSON_BODY]  -> the same with the deploy token
cf() { cf_as "$CLOUDFLARE_API_TOKEN" "$@"; }

# json EXPR  -> evaluates a JS expression against the JSON on stdin (r = parsed body); exits 3 on null.
# Values from the shell go in through the environment (V=... json '... process.env.V ...'),
# never by splicing them into the expression.
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

# toml KEY FILE  -> the first `KEY = "value"` in a wrangler.toml (the value up to the next quote)
toml() { sed -n "s/^$1 = \"\([^\"]*\)\".*/\1/p" "$2" | head -n 1; }

# sed_esc VALUE  -> VALUE safe for the replacement side of a sed s|…|…| command
sed_esc() { printf '%s' "$1" | sed 's/[|&\\]/\\&/g'; }

# is_hostname NAME  -> true for a bare, lowercase DNS hostname with at least two labels
is_hostname() {
  printf '%s' "$1" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
}
# is_env_name NAME  -> lowercase letters, digits and hyphens, as the Workers, bucket and database names need
is_env_name() { printf '%s' "$1" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'; }
# is_domain_list LIST  -> comma-separated lowercase domains, as the Access policy takes
is_domain_list() { printf '%s' "$1" | grep -Eq '^[a-z0-9.-]+(,[a-z0-9.-]+)*$'; }
# is_git_source URL  -> https://, ssh://, git@host:path, or a local path; nothing plaintext
is_git_source() {
  case "$1" in
    https://*|ssh://*|/*|./*|../*) return 0 ;;
    git@*:*) return 0 ;;
    *) return 1 ;;
  esac
}

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
