#!/bin/sh
# Creates what a deployment needs besides the Workers themselves, and writes
# the resulting ids into its library.toml (and the database id into its
# resizer.toml, when the resizer binds the database for the metadata API):
#   - the Zero Trust organization, if the account has none, with One-time PIN
#   - the Access application for the library's hostname, allowing the email
#     domains in ACCESS_ALLOWED_EMAIL_DOMAINS
#   - the R2 bucket and the D1 database, and the bucket's CORS rule that lets
#     the library's pages put masters straight into it
# Safe to re-run: each step reuses what already exists and updates the policy.
#
#   sh scripts/provision.sh deploy/<name>
#
# Needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and (for the library)
# ACCESS_ALLOWED_EMAIL_DOMAINS, from the environment or ./.env. To create a
# Zero Trust organization, also ACCESS_TEAM_NAME. See deploy/example.
set -eu
. "$(dirname -- "$0")/lib.sh"
ENV_DIR=$(env_dir "${1:?usage: provision.sh <environment directory>}")
ENV_NAME=$(basename -- "$ENV_DIR")
is_env_name "$ENV_NAME" || { echo "provision: the environment directory name must be lowercase letters, digits and hyphens (it names the Access application): $ENV_NAME" >&2; exit 2; }
need_credentials
case "$CLOUDFLARE_ACCOUNT_ID" in *[!0-9a-f]*|"") echo "CLOUDFLARE_ACCOUNT_ID must be 32 hex characters" >&2; exit 1 ;; esac
A="/accounts/$CLOUDFLARE_ACCOUNT_ID"
LIB="$ENV_DIR/library.toml"
RES="$ENV_DIR/resizer.toml"

if [ -f "$LIB" ]; then
  : "${ACCESS_ALLOWED_EMAIL_DOMAINS:?set ACCESS_ALLOWED_EMAIL_DOMAINS, e.g. example.com,example.org}"
  # These values are spliced into JSON bodies and the Access policy; only the
  # shapes the API expects get through.
  is_domain_list "$ACCESS_ALLOWED_EMAIL_DOMAINS" || { echo "ACCESS_ALLOWED_EMAIL_DOMAINS must be comma-separated lowercase domains, e.g. example.com,example.org" >&2; exit 1; }
  case "${ACCESS_TEAM_NAME:-}" in *[!a-z0-9-]*) echo "ACCESS_TEAM_NAME must be lowercase letters, digits and hyphens" >&2; exit 1 ;; esac
  HOST=$(sed -n 's/.*pattern = "\([^"]*\)".*/\1/p' "$LIB" | head -n 1)
  [ -n "$HOST" ] || { echo "$LIB has no route pattern" >&2; exit 1; }
  is_hostname "$HOST" || { echo "$LIB: the route pattern $HOST is not a bare lowercase hostname" >&2; exit 1; }

  echo "== Zero Trust organization"
  org=$(cf GET "$A/access/organizations")
  if TEAM_DOMAIN=$(printf '%s' "$org" | json 'r.success && r.result && r.result.auth_domain' 2>/dev/null); then
    echo "   exists: $TEAM_DOMAIN"
  else
    : "${ACCESS_TEAM_NAME:?no Zero Trust organization found; set ACCESS_TEAM_NAME to create one}"
    res=$(cf POST "$A/access/organizations" "{\"name\":\"$ACCESS_TEAM_NAME\",\"auth_domain\":\"$ACCESS_TEAM_NAME.cloudflareaccess.com\"}")
    ok "$res"
    TEAM_DOMAIN=$(printf '%s' "$res" | json 'r.result.auth_domain')
    echo "   created: $TEAM_DOMAIN"
  fi

  echo "== One-time PIN identity provider"
  idps=$(cf GET "$A/access/identity_providers")
  ok "$idps"
  if [ "$(printf '%s' "$idps" | json 'r.result.filter(i=>i.type==="onetimepin").length')" = "0" ]; then
    res=$(cf POST "$A/access/identity_providers" '{"name":"One-time PIN","type":"onetimepin","config":{}}')
    ok "$res"
    echo "   created"
  else
    echo "   exists"
  fi

  echo "== Access application for $HOST"
  include=$(printf '%s' "$ACCESS_ALLOWED_EMAIL_DOMAINS" | tr ',' '\n' | sed 's/^ *//;s/ *$//;/^$/d' \
    | sed 's/.*/{"email_domain":{"domain":"&"}}/' | paste -sd, -)
  apps=$(cf GET "$A/access/apps")
  ok "$apps"
  APP_ID=$(printf '%s' "$apps" | V="$HOST" json '(r.result.find(a=>a.domain===process.env.V)||{}).id' 2>/dev/null || true)
  policy="{\"name\":\"Allowed email domains\",\"decision\":\"allow\",\"precedence\":1,\"include\":[$include]}"
  body="{\"name\":\"PhotonRelic $ENV_NAME\",\"domain\":\"$HOST\",\"type\":\"self_hosted\",\"session_duration\":\"24h\",\"http_only_cookie_attribute\":true,\"policies\":[$policy]}"
  if [ -n "$APP_ID" ]; then
    res=$(cf PUT "$A/access/apps/$APP_ID" "$body")
    ok "$res"
    echo "   updated $APP_ID"
  else
    res=$(cf POST "$A/access/apps" "$body")
    ok "$res"
    APP_ID=$(printf '%s' "$res" | json 'r.result.id')
    echo "   created $APP_ID"
  fi
  AUD=$(printf '%s' "$res" | json 'r.result.aud')
fi

BUCKET=""
[ ! -f "$LIB" ] || BUCKET=$(toml bucket_name "$LIB")
[ -n "$BUCKET" ] || [ ! -f "$RES" ] || BUCKET=$(toml bucket_name "$RES")
case "$BUCKET" in *[!a-z0-9.-]*) echo "bucket_name must be lowercase letters, digits, dots and hyphens: $BUCKET" >&2; exit 1 ;; esac
if [ -n "$BUCKET" ]; then
  echo "== R2 bucket $BUCKET"
  res=$(cf POST "$A/r2/buckets" "{\"name\":\"$BUCKET\"}")
  if [ "$(printf '%s' "$res" | json 'r.success' 2>/dev/null)" = "true" ]; then
    echo "   created"
  elif printf '%s' "$res" | grep -q 'already exists'; then
    echo "   exists"
  else
    ok "$res"
  fi
  # Master uploads go from the library's pages straight to the bucket on signed
  # URLs, which the browser only allows with a CORS rule naming the library's
  # origin; the ETag must be exposed for multipart parts. Set every time.
  if [ -f "$LIB" ]; then
    echo "== CORS on $BUCKET for https://$HOST"
    res=$(cf PUT "$A/r2/buckets/$BUCKET/cors" "{\"rules\":[{\"allowed\":{\"origins\":[\"https://$HOST\"],\"methods\":[\"PUT\"],\"headers\":[\"content-type\"]},\"exposeHeaders\":[\"ETag\"],\"maxAgeSeconds\":3600}]}")
    ok "$res"
    echo "   set"
  fi
fi

# The database is the library's; the resizer may bind the same one for its
# metadata API, so its id is written into both files that name it.
DB_NAME=""
[ ! -f "$LIB" ] || DB_NAME=$(toml database_name "$LIB")
[ -n "$DB_NAME" ] || [ ! -f "$RES" ] || DB_NAME=$(toml database_name "$RES")
DB_ID=""
case "$DB_NAME" in *[!a-z0-9_-]*) echo "database_name must be lowercase letters, digits, underscores and hyphens: $DB_NAME" >&2; exit 1 ;; esac
if [ -n "$DB_NAME" ]; then
  echo "== D1 database $DB_NAME"
  dbs=$(cf GET "$A/d1/database?name=$DB_NAME")
  ok "$dbs"
  DB_ID=$(printf '%s' "$dbs" | V="$DB_NAME" json '(r.result.find(d=>d.name===process.env.V)||{}).uuid' 2>/dev/null || true)
  if [ -n "$DB_ID" ]; then
    echo "   exists $DB_ID"
  else
    res=$(cf POST "$A/d1/database" "{\"name\":\"$DB_NAME\"}")
    ok "$res"
    DB_ID=$(printf '%s' "$res" | json 'r.result.uuid')
    echo "   created $DB_ID"
  fi
fi

if [ -f "$LIB" ]; then
  echo "== writing $LIB"
  # Values that came back from the API are escaped for the replacement side.
  tmp=$(mktemp)
  sed -e "s|^ACCESS_TEAM_DOMAIN = \".*\"|ACCESS_TEAM_DOMAIN = \"$(sed_esc "$TEAM_DOMAIN")\"|" \
      -e "s|^ACCESS_AUD = \".*\"|ACCESS_AUD = \"$(sed_esc "$AUD")\"|" \
      -e "s|^CF_ACCOUNT_ID = \".*\"|CF_ACCOUNT_ID = \"$CLOUDFLARE_ACCOUNT_ID\"|" \
      -e "s|^MEDIA_BUCKET = \".*\"|MEDIA_BUCKET = \"$BUCKET\"|" \
      -e "s|^database_id = \".*\"|database_id = \"$(sed_esc "$DB_ID")\"|" "$LIB" > "$tmp" && mv "$tmp" "$LIB"
  grep -E '^(ACCESS_TEAM_DOMAIN|ACCESS_AUD|CF_ACCOUNT_ID|MEDIA_BUCKET|database_id) ' "$LIB"
fi

if [ -f "$RES" ] && [ -n "$(toml database_name "$RES")" ]; then
  if [ "$(toml database_name "$RES")" = "$DB_NAME" ]; then
    echo "== writing $RES"
    tmp=$(mktemp)
    sed -e "s|^database_id = \".*\"|database_id = \"$(sed_esc "$DB_ID")\"|" "$RES" > "$tmp" && mv "$tmp" "$RES"
    grep -E '^database_id ' "$RES"
  else
    echo "$RES names database $(toml database_name "$RES"), not the library's $DB_NAME; its database_id was left alone" >&2
  fi
fi
echo "done. Next: sh $ROOT/scripts/deploy.sh $ENV_DIR"
