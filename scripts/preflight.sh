#!/bin/sh
# Checks, before anything is created, that this machine, the token and the
# account can carry a deployment through provision.sh and deploy.sh. Nothing
# is changed; every check prints pass or FAIL with what to do about it.
#
#   sh scripts/preflight.sh deploy/<name>
#
# Reads CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and the optional tokens
# from the environment or ./.env, like the other scripts. A check that this
# token cannot make (the account's plan, whether Images is enabled) says so
# and names the dashboard page; scripts/verify.sh settles Images after the
# deploy from the resizer's own response.
set -eu
. "$(dirname -- "$0")/lib.sh"
ENV_DIR=$(env_dir "${1:?usage: preflight.sh <environment directory>}")
LIB="$ENV_DIR/library.toml"
RES="$ENV_DIR/resizer.toml"
PASS=0; FAILS=0
pass() { PASS=$((PASS + 1)); printf 'pass  %s\n' "$1"; }
fail() { FAILS=$((FAILS + 1)); printf 'FAIL  %s\n      fix: %s\n' "$1" "$2"; }
note() { printf 'note  %s\n' "$1"; }

# A GET against the API: prints "ok", "denied" (the token lacks the permission),
# or the first error message, so a probe can tell a missing permission from a
# product that is not enabled.
probe() {
  res=$(cf GET "$1")
  if [ "$(printf '%s' "$res" | json 'r.success' 2>/dev/null || true)" = "true" ]; then echo ok; return; fi
  code=$(printf '%s' "$res" | json 'r.errors && r.errors[0] && r.errors[0].code' 2>/dev/null || true)
  case "$code" in 10000|9109|7000|7003) echo denied ;; *) printf '%s' "$res" | json 'r.errors && r.errors[0] && r.errors[0].message' 2>/dev/null || echo "unexpected response" ;; esac
}
# probe_perm PATH "Permission name"  -> pass or FAIL naming the permission
probe_perm() {
  out=$(probe "$1")
  case "$out" in
    ok) pass "token can reach $2" ;;
    denied) fail "token lacks $2" "edit the token at dash.cloudflare.com → My Profile → API Tokens and add $2" ;;
    *) fail "$2: $out" "see the message above" ;;
  esac
}
routes() { sed -n 's/.*pattern = "\([^"]*\)".*/\1/p' "$1"; }
verify_token() {   # verify_token TOKEN -> "active", "denied" or an error message
  res=$(curl -sS -H "Authorization: Bearer $1" "https://api.cloudflare.com/client/v4/user/tokens/verify")
  st=$(printf '%s' "$res" | json '(r.success && r.result && r.result.status) || null' 2>/dev/null || true)
  if [ -z "$st" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    res=$(curl -sS -H "Authorization: Bearer $1" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/tokens/verify")
    st=$(printf '%s' "$res" | json '(r.success && r.result && r.result.status) || null' 2>/dev/null || true)
  fi
  [ -n "$st" ] && printf '%s' "$st" || printf '%s' "$res" | json 'r.errors && r.errors[0] && r.errors[0].message' 2>/dev/null || echo "no answer"
}

echo "== This machine"
if command -v node >/dev/null 2>&1; then
  v=$(node -p 'process.versions.node')
  if node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then pass "node $v"; else fail "node $v is older than 22.13" "install Node 22.13 or later (nvm install 22)"; fi
else fail "node is not installed" "install Node 22.13 or later"; fi
if command -v pnpm >/dev/null 2>&1; then pass "pnpm $(pnpm --version)"; else fail "pnpm is not installed" "run: npm install -g pnpm@12 (or corepack enable on Node 22 to 24)"; fi
command -v curl >/dev/null 2>&1 && pass "curl" || fail "curl is not installed" "install curl"
[ -d "$ROOT/node_modules" ] && pass "dependencies installed" || note "dependencies not installed yet; deploy.sh runs pnpm install itself"

echo "== Credentials"
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  fail "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not both set" "cp .env.example .env in the directory you run the scripts from, and fill them in"
  printf '\npreflight: %d passed, %d failed; the account checks need the credentials\n' "$PASS" "$FAILS"; exit 1
fi
pass "credentials present"
st=$(verify_token "$CLOUDFLARE_API_TOKEN")
if [ "$st" = "active" ]; then pass "deploy token is valid and active"
else
  fail "deploy token did not verify: $st" "create the token again (docs/deploy.md, Tokens) and put it in .env"
  printf '\npreflight: %d passed, %d failed; the account checks need a working token\n' "$PASS" "$FAILS"; exit 1
fi
A="/accounts/$CLOUDFLARE_ACCOUNT_ID"

echo "== Account permissions and products"
probe_perm "$A/workers/scripts" "Workers Scripts: Edit"
out=$(probe "$A/r2/buckets")
case "$out" in
  ok) pass "R2 is enabled and the token can reach it" ;;
  denied) fail "token lacks Workers R2 Storage: Edit" "add Workers R2 Storage: Edit to the token" ;;
  *) fail "R2: $out" "enable R2 once in the dashboard (R2 → Overview → Get started), then run preflight again" ;;
esac
probe_perm "$A/d1/database" "D1: Edit"
if [ -f "$LIB" ]; then
  probe_perm "$A/access/apps" "Access: Apps and Policies: Edit"
  out=$(probe "$A/access/organizations")
  case "$out" in
    ok) pass "Zero Trust organization exists ($(cf GET "$A/access/organizations" | json '(r.result && r.result.auth_domain) || null' 2>/dev/null || echo '?'))" ;;
    denied) fail "token lacks Access: Organizations, Identity Providers, and Groups: Edit" "add that permission to the token" ;;
    *) if [ -n "${ACCESS_TEAM_NAME:-}" ]; then pass "no Zero Trust organization yet; provision.sh will create $ACCESS_TEAM_NAME.cloudflareaccess.com"
       else fail "no Zero Trust organization, and ACCESS_TEAM_NAME is not set" "enable Zero Trust once in the dashboard (Zero Trust → choose the Free plan), or set ACCESS_TEAM_NAME in .env so provision.sh creates the organization"; fi ;;
  esac
  if [ -n "${ACCESS_ALLOWED_EMAIL_DOMAINS:-}" ]; then pass "ACCESS_ALLOWED_EMAIL_DOMAINS = $ACCESS_ALLOWED_EMAIL_DOMAINS"
  else fail "ACCESS_ALLOWED_EMAIL_DOMAINS is not set" "set it in .env to the email domains staff sign in with, e.g. example.com"; fi
fi
note "the account's plan cannot be read with this token: confirm Workers & Pages → Plans shows Workers Paid (the resizer needs it; README, Setup)"
note "whether Images is enabled cannot be read with this token: confirm Images → Overview; scripts/verify.sh reports it after the deploy"

echo "== Hostnames and zones"
hosts=$( { [ -f "$LIB" ] && routes "$LIB"; [ -f "$RES" ] && routes "$RES"; } | sort -u)
[ -n "$hosts" ] || fail "no route pattern in $ENV_DIR" "set routes = [{ pattern = \"host.example.com\", custom_domain = true }] in each TOML"
seen=""
for h in $hosts; do
  case "$h" in *example.com) fail "$h is the template's placeholder hostname" "edit the routes in $ENV_DIR to your own hostnames"; continue ;; esac
  zone=""; zid=""; probe_name="$h"
  while [ -n "$probe_name" ] && [ -z "$zid" ]; do
    r=$(cf GET "/zones?name=$probe_name")
    zid=$(printf '%s' "$r" | json '(r.success && r.result && r.result[0] && r.result[0].id) || null' 2>/dev/null || true)
    [ -n "$zid" ] && zone="$probe_name" || { case "$probe_name" in *.*) probe_name=${probe_name#*.} ;; *) probe_name="" ;; esac; }
  done
  if [ -z "$zid" ]; then
    fail "$h is not under a zone this token can see in this account" "add the domain to this Cloudflare account (Websites → Add a domain), or give the token Zone permissions on it"
    continue
  fi
  pass "$h is in zone $zone"
  case " $seen " in *" $zid "*) continue ;; esac
  seen="$seen $zid"
  out=$(probe "/zones/$zid/dns_records"); [ "$out" = ok ] && pass "token can manage DNS on $zone" || fail "token lacks DNS: Edit on $zone" "add Zone → DNS → Edit for $zone (custom domains create their DNS records)"
  out=$(probe "/zones/$zid/workers/routes"); [ "$out" = ok ] && pass "token can manage Workers Routes on $zone" || fail "token lacks Workers Routes: Edit on $zone" "add Zone → Workers Routes → Edit for $zone"
done

echo "== Optional tokens in .env"
if [ -n "${ANALYTICS_TOKEN:-}" ]; then st=$(verify_token "$ANALYTICS_TOKEN"); [ "$st" = active ] && pass "ANALYTICS_TOKEN is valid (usage counts)" || fail "ANALYTICS_TOKEN did not verify: $st" "recreate it with Account → Account Analytics → Read"; else note "ANALYTICS_TOKEN not set: usage counts stay off (optional)"; fi
if [ -n "${CACHE_PURGE_TOKEN:-}" ]; then
  st=$(verify_token "$CACHE_PURGE_TOKEN"); [ "$st" = active ] && pass "CACHE_PURGE_TOKEN is valid (cache purge)" || fail "CACHE_PURGE_TOKEN did not verify: $st" "recreate it with Zone → Cache Purge → Purge on the resizer's zone"
  if [ -f "$LIB" ] && ! grep -q '^CF_ZONE_ID = "' "$LIB"; then fail "CACHE_PURGE_TOKEN is set but library.toml has no CF_ZONE_ID" "uncomment CF_ZONE_ID in library.toml with the resizer's zone id; the library refuses to start with one and not the other"; fi
else note "CACHE_PURGE_TOKEN not set: cached copies expire on their own within a day (optional)"; fi
if [ -n "${R2_ACCESS_KEY_ID:-}" ] || [ -n "${R2_SECRET_ACCESS_KEY:-}" ]; then
  if [ -n "${R2_ACCESS_KEY_ID:-}" ] && [ -n "${R2_SECRET_ACCESS_KEY:-}" ]; then pass "R2 token pair present (masters in the bucket)"; else fail "only one half of the R2 token pair is set" "set both R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, or neither; the library refuses to start on one"; fi
else note "R2 token pair not set: masters can be linked but not stored in the bucket (optional)"; fi

echo "== Environment files"
for f in "$LIB" "$RES"; do
  [ -f "$f" ] || continue
  if grep -q '= "REPLACE_' "$f"; then note "$(basename "$f") has REPLACE_ placeholders: provision.sh fills them"; else pass "$(basename "$f") is provisioned"; fi
done

printf '\npreflight: %d passed, %d failed\n' "$PASS" "$FAILS"
if [ "$FAILS" -gt 0 ]; then exit 1; fi
echo "next: sh $ROOT/scripts/provision.sh $ENV_DIR"
