#!/bin/sh
# Mints the API tokens a deployment needs, each named and scoped to the one
# thing it does, and writes them into ./.env. It needs one token from you: a
# bootstrap token with the single permission Account → Account API Tokens →
# Edit on the one account, passed in the environment as
# CLOUDFLARE_BOOTSTRAP_TOKEN. That token is never written to a file by this
# script. Create it under Manage Account → Account API Tokens: an account-owned
# token can delete itself at the end (--retire-bootstrap). A user token (My
# Profile → API Tokens) works for minting, but can delete itself only if it
# also has User → API Tokens → Edit; otherwise you delete it in the dashboard.
#
#   sh scripts/mint-tokens.sh deploy/<name> [--deploy] [--usage] [--purge] [--masters]
#                                            [--all] [--expires <days>] [--retire-bootstrap]
#
#   --deploy    CLOUDFLARE_API_TOKEN: Workers Scripts, R2, D1, Access apps and
#               organizations on the whole account; Workers Routes and DNS on
#               the zones of the two hostnames only. What deploy.sh and
#               provision.sh use.
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
# A variable already set in .env is left alone and reported; an existing deploy
# token is checked for the zone scope it should have. A token that can mint
# tokens is as powerful as anything it mints: give the bootstrap token a short
# expiry and your IP, and retire it when the installation is done.
set -eu
. "$(dirname -- "$0")/lib.sh"
usage() { sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
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
is_env_name "$ENVNAME" || die "the environment directory name must be lowercase letters, digits and hyphens (it names the tokens): $ENVNAME"
LIB="$ENV_DIR/library.toml"; RES="$ENV_DIR/resizer.toml"
# The bootstrap token moves into a shell variable and out of the environment,
# so no child process (curl, node, git) inherits it.
BOOT=${CLOUDFLARE_BOOTSTRAP_TOKEN:?set CLOUDFLARE_BOOTSTRAP_TOKEN in the environment (a token with Account API Tokens Edit); this script never writes it to a file}
unset CLOUDFLARE_BOOTSTRAP_TOKEN
case "$BOOT" in *[!A-Za-z0-9_-]*) die "CLOUDFLARE_BOOTSTRAP_TOKEN does not look like an API token" ;; esac
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID (environment or ./.env)}"
case "$CLOUDFLARE_ACCOUNT_ID" in *[!0-9a-f]*|"") die "CLOUDFLARE_ACCOUNT_ID must be 32 hex characters" ;; esac
A=$CLOUDFLARE_ACCOUNT_ID
case "$EXPIRES" in ""|*[!0-9]*) [ -z "$EXPIRES" ] || die "--expires takes a number of days" ;; esac

# cfb METHOD PATH [JSON]  -> a call with the bootstrap token (header via stdin, like cf)
cfb() { cf_as "$BOOT" "$@"; }
# env_has VAR -> true when .env sets it to something
env_has() { [ -f ./.env ] && grep -Eq "^$1=.+" ./.env; }
# env_set VAR VALUE -> appends to .env (mode 600), never echoing the value
env_set() {
  [ -f ./.env ] || ( umask 077; : > ./.env )
  chmod 600 ./.env
  printf '%s=%s\n' "$1" "$2" >> ./.env
}
# env_note TEXT -> a comment line in .env (the deploy token's id, so a re-run can find it)
env_note() { [ -f ./.env ] || ( umask 077; : > ./.env ); chmod 600 ./.env; printf '# %s\n' "$1" >> ./.env; }
errors_of() { printf '%s' "$1" | json '(r.errors || []).map(e=>e.code+" "+e.message).join("; ") || "no detail"' 2>/dev/null || echo "no answer"; }

echo "== Bootstrap token"
# The bootstrap token may be account-owned or user-owned (made at My Profile);
# that decides which endpoint deletes it later.
SELF_KIND=account
v=$(cfb GET "/accounts/$A/tokens/verify")
SELF_ID=$(printf '%s' "$v" | json '(r.success && r.result && r.result.status === "active" && r.result.id) || null' 2>/dev/null) \
  || { SELF_KIND=user; v=$(cfb GET "/user/tokens/verify"); SELF_ID=$(printf '%s' "$v" | json '(r.success && r.result && r.result.status === "active" && r.result.id) || null' 2>/dev/null) || die "the bootstrap token did not verify: $(errors_of "$v")"; }
exp=$(printf '%s' "$v" | json '(r.result && r.result.expires_on) || null' 2>/dev/null || true)
if [ -n "$exp" ]; then echo "   valid ($SELF_KIND-owned, expires $exp)"
else echo "   valid ($SELF_KIND-owned)"; echo "   note: this bootstrap token has no expiry. A token that can create tokens should expire within a day; retire it when you are done (--retire-bootstrap)"; fi
groups=$(cfb GET "/accounts/$A/tokens/permission_groups")
printf '%s' "$groups" | json 'r.success || null' >/dev/null 2>&1 || die "the bootstrap token cannot list permission groups: it needs Account → Account API Tokens → Edit. $(errors_of "$groups")"
# pg NAME SCOPE -> the permission group id for an API name at a scope. The same
# name exists at several scopes (account and zone both have "Access: Apps and
# Policies Write"), and a group used at the wrong scope grants nothing.
SCOPE_ACCOUNT=com.cloudflare.api.account; SCOPE_ZONE=com.cloudflare.api.account.zone; SCOPE_BUCKET=com.cloudflare.edge.r2.bucket
pg() {
  id=$(printf '%s' "$groups" | N="$1" S="$2" json '(r.result.find(g => g.name === process.env.N && (g.scopes || []).includes(process.env.S)) || {}).id || null' 2>/dev/null) \
    || die "no permission group named \"$1\" for $2 is available to this account; the API's names may have changed. Available at that scope: $(printf '%s' "$groups" | S="$2" json 'r.result.filter(g => (g.scopes || []).includes(process.env.S)).map(g=>g.name).sort().join(", ")')"
  printf '%s' "$id"
}
# zone_id HOST -> the zone id of the zone a hostname is under, looked up with
# the deploy token (lib.sh's cf), which can see the zones it manages. The
# bootstrap token itself needs no zone permission. Returns 1 when none is found.
zone_id() {
  h=$1
  while [ -n "$h" ]; do
    zid=$(cf GET "/zones?name=$h" | json '(r.success && r.result && r.result[0] && r.result[0].id) || null' 2>/dev/null) && { printf '%s' "$zid"; return 0; }
    case "$h" in *.*) h=${h#*.} ;; *) break ;; esac
  done
  return 1
}
# wait_for_token -> a freshly minted token can take a moment to work; returns 1 after 20 s
wait_for_token() {
  n=0
  until cf GET "/user/tokens/verify" 2>/dev/null | json 'r.success || null' >/dev/null 2>&1 || cf GET "/accounts/$A/tokens/verify" 2>/dev/null | json 'r.success || null' >/dev/null 2>&1; do
    n=$((n + 1)); [ "$n" -le 10 ] || return 1
    sleep 2
  done
}
# token_path ID KIND -> the API path of a token
token_path() { case "$2" in account) printf '/accounts/%s/tokens/%s' "$A" "$1" ;; *) printf '/user/tokens/%s' "$1" ;; esac; }
# narrow ID KIND NAME POLICIES -> replaces a token's policies
narrow() {
  r=$(cfb PUT "$(token_path "$1" "$2")" "{\"name\": \"$3\", \"policies\": $4, \"status\": \"active\"$(expires_json)}")
  printf '%s' "$r" | json 'r.success || null' >/dev/null 2>&1
}
# delete_token ID KIND -> best effort; reports failure
delete_token() {
  r=$(cfb DELETE "$(token_path "$1" "$2")")
  printf '%s' "$r" | json 'r.success || null' >/dev/null 2>&1 || echo "   could not delete token $1; delete it in the dashboard" >&2
}
# existing_named NAME -> prints the ids of account tokens with that name (empty when none, or when the bootstrap token cannot list)
existing_named() { cfb GET "/accounts/$A/tokens?per_page=50" | N="$1" json '(r.success && r.result.filter(t=>t.name===process.env.N).map(t=>t.id).join(" ")) || ""' 2>/dev/null || true; }
expires_json() { [ -n "$EXPIRES" ] || return 0; node -e 'const d=new Date(Date.now()+Number(process.argv[1])*86400000);process.stdout.write(", \"expires_on\": "+JSON.stringify(d.toISOString().replace(/\.\d{3}Z$/,"Z")))' "$EXPIRES"; }
# mint NAME POLICIES_JSON -> prints "id value" of a new token, or nothing on
# failure (the caller checks). Account-owned when the bootstrap token may
# create those (a service token, tied to no person); otherwise user-owned,
# which is what a My Profile token creates.
MINTED_KIND=account
mint() {
  [ -z "$(existing_named "$1")" ] || echo "   note: a token named $1 already exists; a second one with that name is being created (delete the old one in the dashboard if it is not in use)" >&2
  body="{\"name\": \"$1\", \"policies\": $2$(expires_json)}"
  r=$(cfb POST "/accounts/$A/tokens" "$body")
  if ! printf '%s' "$r" | json 'r.success || null' >/dev/null 2>&1; then
    r2=$(cfb POST "/user/tokens" "$body")
    printf '%s' "$r2" | json 'r.success || null' >/dev/null 2>&1 || { echo "mint-tokens: could not create $1 as an account token ($(errors_of "$r")) nor as a user token ($(errors_of "$r2"))" >&2; return 1; }
    r=$r2; MINTED_KIND=user
  fi
  printf '%s' "$r" | json '(typeof r.result.value === "string" && /^[0-9a-f]{32}$/.test(r.result.id)) ? r.result.id + " " + r.result.value : null' 2>/dev/null || { echo "mint-tokens: the API created $1 but returned no usable value" >&2; return 1; }
}
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
for h in $hosts; do
  case "$h" in example.com|*.example.com) die "$h is the template's placeholder; fill in the hostnames first" ;; esac
  is_hostname "$h" || die "$h is not a bare lowercase hostname; check the route patterns"
done
# The zone policy the deploy token starts with: every zone in the account. Once
# the token exists it looks up the zones of the two hostnames and is narrowed
# to those before anything is written, so the bootstrap token never needs to
# read zones itself, and a token that could not be narrowed is deleted.
ALL_ZONES="{\"com.cloudflare.api.account.$A\": {\"com.cloudflare.api.account.zone.*\": \"*\"}}"
DEPLOY_PG="Workers Scripts Write|Workers R2 Storage Write|D1 Write|Access: Apps and Policies Write|Access: Organizations, Identity Providers, and Groups Write"
deploy_account_policy() { oldIFS=$IFS; IFS='|'; set -- $DEPLOY_PG; IFS=$oldIFS; account_policy "$@"; }
DEPLOY_NAME="photonrelic-$ENVNAME-deploy"

# check_existing_deploy_token -> the token already in .env must not still cover every zone
check_existing_deploy_token() {
  id=$(sed -n 's/^# CLOUDFLARE_API_TOKEN_ID=\([0-9a-f]*\)$/\1/p' ./.env | head -n 1)
  kind=account
  if [ -z "$id" ]; then
    set -- $(existing_named "$DEPLOY_NAME")
    [ $# -eq 1 ] || { echo "   already in .env; left alone (not minted by this script, or more than one token carries its name, so its scope was not checked)"; return 0; }
    id=$1
  fi
  pol=$(cfb GET "$(token_path "$id" account)")
  printf '%s' "$pol" | json 'r.success || null' >/dev/null 2>&1 || { kind=user; pol=$(cfb GET "$(token_path "$id" user)"); }
  printf '%s' "$pol" | json 'r.success || null' >/dev/null 2>&1 || { echo "   already in .env; left alone (token $id could not be read to check its scope)"; return 0; }
  if printf '%s' "$pol" | json 'r.result.policies.some(p => Object.keys(p.resources || {}).some(k => k === "com.cloudflare.api.account.zone.*") || Object.values(p.resources || {}).some(v => typeof v === "object" && v !== null && "com.cloudflare.api.account.zone.*" in v)) || null' >/dev/null 2>&1; then
    die "the deploy token in .env ($id) still has DNS and Workers Routes on every zone in the account. Delete it under $( [ "$kind" = account ] && printf 'Manage Account → Account API Tokens' || printf 'My Profile → API Tokens'), remove the CLOUDFLARE_API_TOKEN and CLOUDFLARE_API_TOKEN_ID lines from .env, and run this again"
  fi
  echo "   already in .env; its zone scope is narrow, left alone"
}

if $DEPLOY; then
  echo "== Deploy token (CLOUDFLARE_API_TOKEN)"
  if env_has CLOUDFLARE_API_TOKEN; then check_existing_deploy_token
  else
    [ -n "$hosts" ] || die "no route pattern in $ENV_DIR; the deploy token is scoped to the hostnames' zones"
    zone_ids="$(pg "Workers Routes Write" "$SCOPE_ZONE")|$(pg "DNS Write" "$SCOPE_ZONE")"
    pol="[$(deploy_account_policy), {\"effect\": \"allow\", \"resources\": $ALL_ZONES, \"permission_groups\": [{\"id\": \"${zone_ids%%|*}\"}, {\"id\": \"${zone_ids##*|}\"}]}]"
    set -- $(mint "$DEPLOY_NAME" "$pol") || true
    [ $# -eq 2 ] || die "the deploy token was not created"
    ID=$1; CLOUDFLARE_API_TOKEN=$2; KIND=$MINTED_KIND
    echo "   created $DEPLOY_NAME (id $ID) on every zone; narrowing it"
    wait_for_token || { delete_token "$ID" "$KIND"; die "the new deploy token did not become usable within 20 seconds; it was deleted. Run this again"; }
    ZONES=""
    for h in $hosts; do
      z=$(zone_id "$h") || { delete_token "$ID" "$KIND"; die "$h is not under a zone in this account (is the domain added as a zone?); the deploy token was deleted, nothing was written"; }
      case " $ZONES " in *" $z "*) ;; *) ZONES="$ZONES${ZONES:+ }$z" ;; esac
    done
    narrow "$ID" "$KIND" "$DEPLOY_NAME" "[$(deploy_account_policy), $(zone_policy "$ZONES" "Workers Routes Write" "DNS Write")]" \
      || { delete_token "$ID" "$KIND"; die "could not narrow the deploy token to the hostnames' zones; it was deleted, nothing was written. Run this again"; }
    env_set CLOUDFLARE_API_TOKEN "$CLOUDFLARE_API_TOKEN"
    env_note "CLOUDFLARE_API_TOKEN_ID=$ID"
    echo "   narrowed to the zone(s) of the hostnames: $ZONES; written to .env"
  fi
fi
# From here on, zone lookups use the deploy token, from .env or just minted.
if { $PURGE; } && [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  load_env ./.env
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "--purge needs the deploy token to find the zone: run with --deploy first, or put CLOUDFLARE_API_TOKEN in .env"
fi
if $USAGE; then
  echo "== Usage token (ANALYTICS_TOKEN)"
  if env_has ANALYTICS_TOKEN; then echo "   already in .env; left alone"
  else
    set -- $(mint "photonrelic-$ENVNAME-usage" "[$(account_policy "Account Analytics Read")]") || true
    [ $# -eq 2 ] || die "the usage token was not created"
    env_set ANALYTICS_TOKEN "$2"
    echo "   created photonrelic-$ENVNAME-usage (id $1), written to .env"
  fi
fi
if $PURGE; then
  echo "== Cache purge token (CACHE_PURGE_TOKEN)"
  [ -f "$RES" ] || die "--purge needs resizer.toml: the purge is scoped to the resizer's zone"
  rz=$(zone_id "$(sed -n 's/.*pattern = "\([^"]*\)".*/\1/p' "$RES" | head -n 1)") || die "the resizer's hostname is not under a zone the deploy token can see"
  if env_has CACHE_PURGE_TOKEN; then echo "   already in .env; left alone"
  else
    set -- $(mint "photonrelic-$ENVNAME-purge" "[$(zone_policy "$rz" "Cache Purge")]") || true
    [ $# -eq 2 ] || die "the purge token was not created"
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
  case "$bucket" in ""|REPLACE_*) die "library.toml has no bucket yet: run provision.sh first" ;; *[!a-z0-9.-]*) die "bucket name $bucket has characters a bucket name cannot have" ;; esac
  if env_has R2_ACCESS_KEY_ID && env_has R2_SECRET_ACCESS_KEY; then echo "   already in .env; left alone"
  elif env_has R2_ACCESS_KEY_ID || env_has R2_SECRET_ACCESS_KEY; then die ".env has one half of the R2 pair; remove it and run again"
  else
    pol="[{\"effect\": \"allow\", \"resources\": {\"com.cloudflare.edge.r2.bucket.${A}_default_${bucket}\": \"*\"}, \"permission_groups\": [{\"id\": \"$(pg "Workers R2 Storage Bucket Item Write" "$SCOPE_BUCKET")\"}]}]"
    set -- $(mint "photonrelic-$ENVNAME-masters" "$pol") || true
    [ $# -eq 2 ] || die "the masters token was not created"
    secret=$(printf '%s' "$2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(require("crypto").createHash("sha256").update(s).digest("hex")))')
    env_set R2_ACCESS_KEY_ID "$1"
    env_set R2_SECRET_ACCESS_KEY "$secret"
    echo "   created photonrelic-$ENVNAME-masters on bucket $bucket, written to .env"
  fi
fi
if $RETIRE; then
  echo "== Retiring the bootstrap token"
  r=$(cfb DELETE "$(token_path "$SELF_ID" "$SELF_KIND")")
  if printf '%s' "$r" | json 'r.success || null' >/dev/null 2>&1; then
    echo "   deleted"
  elif [ "$SELF_KIND" = user ]; then
    echo "   could not delete it: a user-owned token can delete itself only with User → API Tokens → Edit. Delete it now under My Profile → API Tokens. ($(errors_of "$r"))"
  else
    echo "   could not delete it; delete it now under Manage Account → Account API Tokens. ($(errors_of "$r"))"
  fi
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
