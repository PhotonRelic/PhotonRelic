#!/bin/sh
# Checks a deployed environment from the outside, the way a browser and a
# website will meet it, and with credentials also from the inside. Changes
# nothing. Run it after deploy.sh; a clean run means the library is ready for
# its first upload.
#
#   sh scripts/verify.sh deploy/<name> [--key media/some-filed-key.jpg]
#
# Credentials are optional (environment or ./.env): with them the migration
# state and the bucket's CORS rule are checked too. --key names a file the
# library has already filed, so the resizer's transform can be checked; the
# first run has none, and that check is skipped.
set -eu
. "$(dirname -- "$0")/lib.sh"
ENV_DIR=$(env_dir "${1:?usage: verify.sh <environment directory> [--key <key>]}")
KEY=""
[ "${2:-}" != "--key" ] || KEY="${3:?--key needs a key}"
LIB="$ENV_DIR/library.toml"
RES="$ENV_DIR/resizer.toml"
host_of() { sed -n 's/.*pattern = "\([^"]*\)".*/\1/p' "$1" | head -n 1; }
# status URL [header...] -> HTTP status, or 000 when nothing answered
status() { u=$1; shift; st=$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$@" "$u" 2>/dev/null || true); printf '%s' "${st:-000}"; }
header() { curl -s -m 20 -D - -o /dev/null "$2" 2>/dev/null | tr -d '\r' | sed -n "s/^$1: *//Ip" | head -n 1; }

if [ -f "$RES" ]; then
  RH=$(host_of "$RES")
  echo "== Resizer at https://$RH"
  st=$(status "https://$RH/")
  case "$st" in
    000) fail "nothing answered at https://$RH" "a custom domain can take a minute after the first deploy; check the hostname in resizer.toml and that deploy.sh finished" ;;
    5*) fail "https://$RH answered $st" "read the Worker's logs (Workers & Pages → the resizer → Logs) and check its bindings" ;;
    *) pass "answers ($st for the bare origin, as expected)" ;;
  esac
  if [ "$st" != 000 ]; then
    st=$(status "https://$RH/masters/probe"); [ "$st" = 404 ] && pass "refuses masters/ ($st)" || fail "masters/probe answered $st, not 404" "the resizer must never serve masters/; redeploy from a current PhotonRelic"
    body=$(curl -s -m 20 "https://$RH/api/v1/assets/not-a-filed-key" 2>/dev/null || true)
    code=$(printf '%s' "$body" | json '(r.error && r.error.code) || null' 2>/dev/null || true)
    case "$code" in
      NOT_FOUND) pass "metadata API answers (404 NOT_FOUND for an unknown key)" ;;
      API_UNAVAILABLE) note "metadata API is off: resizer.toml has no database block (by configuration)" ;;
      *) fail "metadata API gave an unexpected answer: ${body:-nothing}" "check the resizer's DB binding in resizer.toml and redeploy" ;;
    esac
    if [ -n "$KEY" ]; then
      width=$(sed -n 's/^MEDIA_WIDTHS = "\([0-9]*\).*/\1/p' "$RES" | head -n 1); width=${width:-320}
      url="https://$RH/$KEY?w=$width"
      st=$(status "$url")
      if [ "$st" = 200 ]; then
        xt=$(header x-media-transform "$url")
        if [ -z "$xt" ]; then pass "resizes $KEY at w=$width (Images is enabled)"
        else fail "$KEY was served as stored: x-media-transform: $xt" "enable Images in the dashboard (Images → Overview) and confirm the account is on Workers Paid; the Worker needs no redeploy"; fi
      else fail "$url answered $st" "is $KEY a filed key under SERVED_PREFIXES? pass a key the library lists"; fi
    else note "no --key given: pass a filed key after the first upload to check resizing and Images"; fi
  fi
fi

if [ -f "$LIB" ]; then
  LH=$(host_of "$LIB")
  echo "== Library at https://$LH"
  if grep -q '^ACCESS_AUD = "REPLACE_' "$LIB"; then fail "ACCESS_AUD is still a placeholder" "run scripts/provision.sh, then deploy.sh again"; else pass "ACCESS_AUD is set"; fi
  st=$(status "https://$LH/")
  loc=$(header location "https://$LH/")
  case "$st" in
    000) fail "nothing answered at https://$LH" "a custom domain can take a minute after the first deploy; check the hostname in library.toml" ;;
    302|301|303|307)
      case "$loc" in *cloudflareaccess.com*) pass "redirects to the Access login" ;; *) fail "redirects to $loc, not to Access" "check the Access application for $LH (Zero Trust → Access → Applications)" ;; esac ;;
    200) fail "the library answered 200 without a login" "the hostname is not behind Access: run scripts/provision.sh and check the Access application's domain is exactly $LH" ;;
    *) fail "https://$LH answered $st" "read the Worker's logs; a 500 at start usually means ACCESS_AUD or a half-set optional secret pair" ;;
  esac
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    out=$(pnpm --dir "$ROOT/workers/library" exec wrangler d1 migrations list DB --remote -c "$LIB" 2>&1 || true)
    case "$out" in
      *"No migrations to apply"*) pass "database migrations are all applied" ;;
      *) fail "database has migrations to apply" "run scripts/deploy.sh $ENV_DIR" ;;
    esac
    bucket=$(toml MEDIA_BUCKET "$LIB")
    if [ -n "$bucket" ]; then
      cors=$(cf GET "/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets/$bucket/cors")
      case "$cors" in *"https://$LH"*) pass "bucket CORS allows master uploads from https://$LH" ;; *) note "bucket CORS does not name https://$LH: masters cannot be uploaded from the page until provision.sh runs (optional feature)" ;; esac
    fi
  else
    note "no credentials in the environment or ./.env: migration state and bucket CORS not checked"
  fi
fi

printf '\nverify: %d passed, %d failed\n' "$PASS" "$FAILS"
[ "$FAILS" -eq 0 ] || exit 1
[ ! -f "$LIB" ] || echo "ready: sign in at https://$(host_of "$LIB")/ with an address on an allowed domain and upload your first image"
