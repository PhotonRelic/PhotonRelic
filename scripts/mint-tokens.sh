#!/bin/sh
# Mints the API tokens a deployment needs, each named and scoped to the one
# thing it does, and writes them into ./.env. It needs one token from you: a
# bootstrap token with the single permission Account → Account API Tokens →
# Edit on the one account, passed in the environment as
# CLOUDFLARE_BOOTSTRAP_TOKEN. That token is never written anywhere. (A user
# token made from the "Create additional tokens" template works too.)
#
#   sh scripts/mint-tokens.sh deploy/<name> [--deploy] [--usage] [--purge] [--masters]
#                                            [--all] [--expires <days>] [--retire-bootstrap]
#
#   --deploy    CLOUDFLARE_API_TOKEN: Workers Scripts, R2, D1, Access apps and
#               organizations on the account; Workers Routes and DNS on the
#               zones of the two hostnames. What deploy.sh and provision.sh use.
#   --usage     ANALYTICS_TOKEN: Account Analytics Read. Usage counts.
#   --purge     CACHE_PURGE_TOKEN: Cache Purge on the resizer's zone; also sets
#               CF_ZONE_ID in library.toml.
#   --masters   R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY: an R2 token with
#               Object Read & Write on the media bucket only. The bucket must
#               exist (provision.sh), so this runs after provisioning.
#   --all       all four.
#   --expires   expiry in days for the minted tokens (default: none).
#   --retire-bootstrap   delete the bootstrap token itself when done.
#
# A variable already set in .env is left alone and reported. A token that can
# mint tokens is as powerful as anything it mints: give the bootstrap token a
# short expiry and your IP, and retire it when the installation is done.
set -eu
. "$(dirname -- "$0")/lib.sh"
usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
die() { echo "mint-tokens: $*" >&2; exit 1; }
DEPLOY=false; USAGE=false; PURGE=false; MASTERS=false; EXPIRES=""; RETIRE=false; ENV_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --deploy) DEPLOY=true; shift ;;
    --usage) USAGE=true; shift ;;
    --purge) PURGE=true; shift ;;
    --masters) MASTERS=true; shift ;;
    --all) DEPLOY=true; USAGE=true; PURGE=true; MASTERS=true; shift ;;
    --expires) EXPIRES=${2:?}; shift 2 ;;
    --retire-bootstrap) RETIRE=true; shift ;;
    -h|--help) usage ;;
    -*) echo "mint-tokens: unknown option $1" >&2; usage ;;
    *) [ -z "$ENV_ARG" ] || usage; ENV_ARG=$1; shift ;;
  esac
done
[ -n "$ENV_ARG" ] || usage
$DEPLOY || $USAGE || $PURGE || $MASTERS || $RETIRE || die "say which tokens to mint: --deploy, --usage, --purge, --masters or --all"
ENV_DIR=$(env_dir "$ENV_ARG")
ENVNAME=$(basename "$ENV_DIR")
LIB="$ENV_DIR/library.toml"; RES="$ENV_DIR/resizer.toml"
: "${CLOUDFLARE_BOOTSTRAP_TOKEN:?set CLOUDFLARE_BOOTSTRAP_TOKEN in the environment (a token with Account API Tokens Edit); it is never written to .env}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID (environment or ./.env)}"
A=$CLOUDFLARE_ACCOUNT_ID
case "$EXPIRES" in ""|*[!0-9]*) [ -z "$EXPIRES" ] || die "--expires takes a number of days" ;; esac

# cfb METHOD PATH [JSON]  -> a call with the bootstrap token
cfb() {
  if [ -n "${3:-}" ]; then
    curl -sS -X "$1" -H "Authorization: Bearer $CLOUDFLARE_BOOTSTRAP_TOKEN" -H 'Content-Type: application/json' "https://api.cloudflare.com/client/v4$2" --data "$3"
  else
    curl -sS -X "$1" -H "Authorization: Bearer $CLOUDFLARE_BOOTSTRAP_TOKEN" "https://api.cloudflare.com/client/v4$2"
  fi
}
# env_has VAR -> true when .env sets it to something
env_has() { [ -f ./.env ] && grep -Eq "^$1=.+" ./.env; }
# env_set VAR VALUE -> appends to .env (mode 600), never echoing the value
env_set() {
  [ -f ./.env ] || { umask 077; : > ./.env; }
  chmod 600 ./.env
  printf '%s=%s\n' "$1" "$2" >> ./.env
}

echo "== Bootstrap token"
# The bootstrap token may be account-owned or user-owned (made at My Profile);
# that decides which endpoint deletes it later.
SELF_KIND=account
v=$(cfb GET "/accounts/$A/tokens/verify")
SELF_ID=$(printf '%s' "$v" | json '(r.success && r.result && r.result.status === "active" && r.result.id) || null' 2>/dev/null) \
  || { SELF_KIND=user; v2=$(cfb GET "/user/tokens/verify"); SELF_ID=$(printf '%s' "$v2" | json '(r.success && r.result && r.result.status === "active" && r.result.id) || null' 2>/dev/null) || die "the bootstrap token did not verify: $(printf '%s' "$v" | json '(r.errors && r.errors[0] && r.errors[0].message) || "no answer"' 2>/dev/null || echo "no answer")"; }
echo "   valid ($SELF_KIND-owned)"
groups=$(cfb GET "/accounts/$A/tokens/permission_groups")
printf '%s' "$groups" | json 'r.success || null' >/dev/null 2>&1 || die "the bootstrap token cannot list permission groups: it needs Account → Account API Tokens → Edit. $(printf '%s' "$groups" | json '(r.errors && r.errors[0] && r.errors[0].message) || ""' 2>/dev/null)"
# pg NAME SCOPE -> the permission group id for an API name at a scope. The same
# name exists at several scopes (account and zone both have "Access: Apps and
# Policies Write"), and a group used at the wrong scope grants nothing.
SCOPE_ACCOUNT=com.cloudflare.api.account; SCOPE_ZONE=com.cloudflare.api.account.zone; SCOPE_BUCKET=com.cloudflare.edge.r2.bucket
pg() {
  id=$(printf '%s' "$groups" | json "(r.result.find(g => g.name === $(printf '%s' "$1" | node -p 'JSON.stringify(require("fs").readFileSync(0,"utf8"))') && (g.scopes || []).includes(\"$2\")) || {}).id || null" 2>/dev/null) \
    || die "no permission group named \"$1\" for $2 is available to this account; the API's names may have changed. Available at that scope: $(printf '%s' "$groups" | json "r.result.filter(g => (g.scopes || []).includes(\"$2\")).map(g=>g.name).sort().join(', ')")"
  printf '%s' "$id"
}
# zone_id HOST -> the zone id of the zone a hostname is under, looked up with
# the deploy token (lib.sh's cf), which can see the zones it manages. The
# bootstrap token itself needs no zone permission.
zone_id() {
  h=$1
  while [ -n "$h" ]; do
    zid=$(cf GET "/zones?name=$h" | json '(r.success && r.result && r.result[0] && r.result[0].id) || null' 2>/dev/null) && { printf '%s' "$zid"; return 0; }
    case "$h" in *.*) h=${h#*.} ;; *) break ;; esac
  done
  die "$1 is not under a zone the deploy token can see; is the domain a zone in this account?"
}
# wait_for_token -> a freshly minted token can take a moment to work
wait_for_token() {
  n=0
  until cf GET "/user/tokens/verify" 2>/dev/null | json 'r.success || null' >/dev/null 2>&1 || cf GET "/accounts/$A/tokens/verify" 2>/dev/null | json 'r.success || null' >/dev/null 2>&1; do
    n=$((n + 1)); [ "$n" -le 10 ] || die "the new deploy token did not become usable"
    sleep 2
  done
}
# narrow ID KIND NAME POLICIES -> replaces a token's policies
narrow() {
  case "$2" in account) p="/accounts/$A/tokens/$1" ;; *) p="/user/tokens/$1" ;; esac
  r=$(cfb PUT "$p" "{\"name\": \"$3\", \"policies\": $4, \"status\": \"active\"$(expires_json)}")
  printf '%s' "$r" | json 'r.success || null' >/dev/null 2>&1
}
expires_json() { [ -n "$EXPIRES" ] || return 0; node -e 'const d=new Date(Date.now()+Number(process.argv[1])*86400000);process.stdout.write(", \"expires_on\": "+JSON.stringify(d.toISOString().replace(/\.\d{3}Z$/,"Z")))' "$EXPIRES"; }
# mint NAME POLICIES_JSON -> prints "id value" of a new token. Account-owned
# when the bootstrap token may create those (a service token, tied to no
# person); otherwise user-owned, which is what a My Profile token creates.
mint() {
  body="{\"name\": \"$1\", \"policies\": $2$(expires_json)}"
  r=$(cfb POST "/accounts/$A/tokens" "$body")
  if ! printf '%s' "$r" | json 'r.success || null' >/dev/null 2>&1; then
    r2=$(cfb POST "/user/tokens" "$body")
    printf '%s' "$r2" | json 'r.success || null' >/dev/null 2>&1 || die "could not create $1 as an account token ($(printf '%s' "$r" | json '(r.errors || []).map(e=>e.code+" "+e.message).join("; ")' 2>/dev/null)) nor as a user token ($(printf '%s' "$r2" | json '(r.errors || []).map(e=>e.code+" "+e.message).join("; ")' 2>/dev/null))"
    r=$r2; MINTED_KIND=user
  fi
  printf '%s' "$r" | json 'r.result.id + " " + r.result.value'
}
MINTED_KIND=account
# A policy over the whole account with the named permission groups.
account_policy() {
  ids=""; for n in "$@"; do ids="$ids${ids:+,}{\"id\": \"$(pg "$n" "$SCOPE_ACCOUNT")\"}"; done
  printf '{"effect": "allow", "resources": {"com.cloudflare.api.account.%s": "*"}, "permission_groups": [%s]}' "$A" "$ids"
}
# A policy over one or more zones with the named permission groups: zone_policy "zid1 zid2" NAME...
zone_policy() {
  zones=$1; shift
  res=""; for z in $zones; do res="$res${res:+, }\"com.cloudflare.api.account.zone.$z\": \"*\""; done
  ids=""; for n in "$@"; do ids="$ids${ids:+,}{\"id\": \"$(pg "$n" "$SCOPE_ZONE")\"}"; done
  printf '{"effect": "allow", "resources": {%s}, "permission_groups": [%s]}' "$res" "$ids"
}

hosts=""
[ ! -f "$LIB" ] || hosts="$hosts $(sed -n 's/.*pattern = "\([^"]*\)".*/\1/p' "$LIB" | head -n 1)"
[ ! -f "$RES" ] || hosts="$hosts $(sed -n 's/.*pattern = "\([^"]*\)".*/\1/p' "$RES" | head -n 1)"
for h in $hosts; do case "$h" in *example.com) die "$h is the template's placeholder; fill in the hostnames first" ;; esac; done
# The zone policy the deploy token starts with: every zone in the account. Once
# the token exists it looks up the zones of the two hostnames and is narrowed
# to those, so the bootstrap token never needs to read zones itself.
ALL_ZONES="{\"com.cloudflare.api.account.$A\": {\"com.cloudflare.api.account.zone.*\": \"*\"}}"
DEPLOY_PG="Workers Scripts Write|Workers R2 Storage Write|D1 Write|Access: Apps and Policies Write|Access: Organizations, Identity Providers, and Groups Write"
deploy_account_policy() { oldIFS=$IFS; IFS='|'; set -- $DEPLOY_PG; IFS=$oldIFS; account_policy "$@"; }

if $DEPLOY; then
  echo "== Deploy token (CLOUDFLARE_API_TOKEN)"
  if env_has CLOUDFLARE_API_TOKEN; then echo "   already in .env; left alone"
  else
    zone_ids="$(pg "Workers Routes Write" "$SCOPE_ZONE")|$(pg "DNS Write" "$SCOPE_ZONE")"
    pol="[$(deploy_account_policy), {\"effect\": \"allow\", \"resources\": $ALL_ZONES, \"permission_groups\": [{\"id\": \"${zone_ids%%|*}\"}, {\"id\": \"${zone_ids##*|}\"}]}]"
    set -- $(mint "photonrelic-$ENVNAME-deploy" "$pol")
    env_set CLOUDFLARE_API_TOKEN "$2"
    echo "   created photonrelic-$ENVNAME-deploy (id $1), written to .env"
    CLOUDFLARE_API_TOKEN=$2
    wait_for_token
    ZONES=""
    for h in $hosts; do z=$(zone_id "$h"); case " $ZONES " in *" $z "*) ;; *) ZONES="$ZONES${ZONES:+ }$z" ;; esac; done
    if [ -n "$ZONES" ] && narrow "$1" "$MINTED_KIND" "photonrelic-$ENVNAME-deploy" "[$(deploy_account_policy), $(zone_policy "$ZONES" "Workers Routes Write" "DNS Write")]"; then
      echo "   narrowed to the zone(s) of the hostnames: $ZONES"
    else
      echo "   note: could not narrow it to the hostnames' zones; it covers every zone in the account"
    fi
  fi
fi
# From here on, zone lookups use the deploy token, from .env or just minted.
if { $PURGE; } && [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  CLOUDFLARE_API_TOKEN=$(sed -n 's/^CLOUDFLARE_API_TOKEN=//p' ./.env 2>/dev/null | head -n 1)
  [ -n "$CLOUDFLARE_API_TOKEN" ] || die "--purge needs the deploy token to find the zone: run with --deploy first, or put CLOUDFLARE_API_TOKEN in .env"
fi
if $USAGE; then
  echo "== Usage token (ANALYTICS_TOKEN)"
  if env_has ANALYTICS_TOKEN; then echo "   already in .env; left alone"
  else
    set -- $(mint "photonrelic-$ENVNAME-usage" "[$(account_policy "Account Analytics Read")]")
    env_set ANALYTICS_TOKEN "$2"
    echo "   created photonrelic-$ENVNAME-usage (id $1), written to .env"
  fi
fi
if $PURGE; then
  echo "== Cache purge token (CACHE_PURGE_TOKEN)"
  [ -f "$RES" ] || die "--purge needs resizer.toml: the purge is scoped to the resizer's zone"
  rz=$(zone_id "$(sed -n 's/.*pattern = "\([^"]*\)".*/\1/p' "$RES" | head -n 1)")
  if env_has CACHE_PURGE_TOKEN; then echo "   already in .env; left alone"
  else
    set -- $(mint "photonrelic-$ENVNAME-purge" "[$(zone_policy "$rz" "Cache Purge")]")
    env_set CACHE_PURGE_TOKEN "$2"
    echo "   created photonrelic-$ENVNAME-purge (id $1), written to .env"
  fi
  if [ -f "$LIB" ]; then
    if grep -Eq "^CF_ZONE_ID = \"$rz\"" "$LIB"; then echo "   CF_ZONE_ID already set in library.toml"
    else
      sed -E "s|^# ?CF_ZONE_ID = \".*\"|CF_ZONE_ID = \"$rz\"|" "$LIB" > "$LIB.tmp" && mv "$LIB.tmp" "$LIB"
      grep -Eq "^CF_ZONE_ID = \"$rz\"" "$LIB" || die "could not set CF_ZONE_ID in library.toml; add: CF_ZONE_ID = \"$rz\""
      echo "   CF_ZONE_ID set in library.toml (commit it)"
    fi
  fi
fi
if $MASTERS; then
  echo "== Masters token (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)"
  [ -f "$LIB" ] || die "--masters needs library.toml"
  bucket=$(toml MEDIA_BUCKET "$LIB"); [ -n "$bucket" ] || bucket=$(toml bucket_name "$LIB")
  case "$bucket" in ""|REPLACE_*) die "library.toml has no bucket yet: run provision.sh first" ;; esac
  if env_has R2_ACCESS_KEY_ID && env_has R2_SECRET_ACCESS_KEY; then echo "   already in .env; left alone"
  elif env_has R2_ACCESS_KEY_ID || env_has R2_SECRET_ACCESS_KEY; then die ".env has one half of the R2 pair; remove it and run again"
  else
    pol="[{\"effect\": \"allow\", \"resources\": {\"com.cloudflare.edge.r2.bucket.${A}_default_${bucket}\": \"*\"}, \"permission_groups\": [{\"id\": \"$(pg "Workers R2 Storage Bucket Item Write" "$SCOPE_BUCKET")\"}]}]"
    set -- $(mint "photonrelic-$ENVNAME-masters" "$pol")
    secret=$(printf '%s' "$2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(require("crypto").createHash("sha256").update(s).digest("hex")))')
    env_set R2_ACCESS_KEY_ID "$1"
    env_set R2_SECRET_ACCESS_KEY "$secret"
    echo "   created photonrelic-$ENVNAME-masters (id $1) on bucket $bucket, written to .env"
  fi
fi
if $RETIRE; then
  echo "== Retiring the bootstrap token"
  case "$SELF_KIND" in account) r=$(cfb DELETE "/accounts/$A/tokens/$SELF_ID") ;; *) r=$(cfb DELETE "/user/tokens/$SELF_ID") ;; esac
  if printf '%s' "$r" | json 'r.success || null' >/dev/null 2>&1; then echo "   deleted"; else echo "   could not delete it; delete it in the dashboard: $(printf '%s' "$r" | json '(r.errors && r.errors[0] && r.errors[0].message) || ""' 2>/dev/null)"; fi
fi
echo
case "$MINTED_KIND" in
  account) echo "done. The tokens are listed under Manage Account → Account API Tokens as photonrelic-$ENVNAME-*; .env is mode 600 and never committed." ;;
  *) echo "done. The tokens are user-owned (the bootstrap token could not create account tokens) and listed under My Profile → API Tokens as photonrelic-$ENVNAME-*; they stop working if that user leaves the account. .env is mode 600 and never committed." ;;
esac
if ! $RETIRE; then
  case "$SELF_KIND" in account) where="Manage Account → Account API Tokens" ;; *) where="My Profile → API Tokens" ;; esac
  echo "The bootstrap token is still valid and can create any token in the account. When you are done with it, run this script with --retire-bootstrap, or delete it under $where."
fi
