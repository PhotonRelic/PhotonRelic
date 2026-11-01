#!/bin/sh
# Creates what a deployment needs besides the Workers themselves, and writes
# the resulting ids into its library.toml:
#   - the Zero Trust organisation, if the account has none, with One-time PIN
#   - the Access application for the library's hostname, allowing the email
#     domains in ACCESS_ALLOWED_EMAIL_DOMAINS
#   - the R2 bucket and the D1 database
# Safe to re-run: each step reuses what already exists and updates the policy.
#
#   sh scripts/provision.sh deploy/<name>
#
# Needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and (for the library)
# ACCESS_ALLOWED_EMAIL_DOMAINS, from the environment or ./.env. To create a
# Zero Trust organisation, also ACCESS_TEAM_NAME. See deploy/example.
set -eu
. "$(dirname -- "$0")/lib.sh"
ENV_DIR=$(env_dir "${1:?usage: provision.sh <environment directory>}")
ENV_NAME=$(basename -- "$ENV_DIR")
need_credentials
A="/accounts/$CLOUDFLARE_ACCOUNT_ID"
LIB="$ENV_DIR/library.toml"
RES="$ENV_DIR/resizer.toml"

if [ -f "$LIB" ]; then
  : "${ACCESS_ALLOWED_EMAIL_DOMAINS:?set ACCESS_ALLOWED_EMAIL_DOMAINS, e.g. example.com,example.org}"
  HOST=$(sed -n 's/.*pattern = "\([^"]*\)".*/\1/p' "$LIB" | head -n 1)
  [ -n "$HOST" ] || { echo "$LIB has no route pattern" >&2; exit 1; }

  echo "== Zero Trust organisation"
  org=$(cf GET "$A/access/organizations")
  if TEAM_DOMAIN=$(printf '%s' "$org" | json 'r.success && r.result && r.result.auth_domain' 2>/dev/null); then
    echo "   exists: $TEAM_DOMAIN"
  else
    : "${ACCESS_TEAM_NAME:?no Zero Trust organisation found; set ACCESS_TEAM_NAME to create one}"
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
  APP_ID=$(printf '%s' "$apps" | json "(r.result.find(a=>a.domain===\"$HOST\")||{}).id" 2>/dev/null || true)
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
fi

if [ -f "$LIB" ]; then
  DB_NAME=$(toml database_name "$LIB")
  echo "== D1 database $DB_NAME"
  dbs=$(cf GET "$A/d1/database?name=$DB_NAME")
  ok "$dbs"
  DB_ID=$(printf '%s' "$dbs" | json "(r.result.find(d=>d.name===\"$DB_NAME\")||{}).uuid" 2>/dev/null || true)
  if [ -n "$DB_ID" ]; then
    echo "   exists $DB_ID"
  else
    res=$(cf POST "$A/d1/database" "{\"name\":\"$DB_NAME\"}")
    ok "$res"
    DB_ID=$(printf '%s' "$res" | json 'r.result.uuid')
    echo "   created $DB_ID"
  fi

  echo "== writing $LIB"
  tmp=$(mktemp)
  sed -e "s|^ACCESS_TEAM_DOMAIN = \".*\"|ACCESS_TEAM_DOMAIN = \"$TEAM_DOMAIN\"|" \
      -e "s|^ACCESS_AUD = \".*\"|ACCESS_AUD = \"$AUD\"|" \
      -e "s|^CF_ACCOUNT_ID = \".*\"|CF_ACCOUNT_ID = \"$CLOUDFLARE_ACCOUNT_ID\"|" \
      -e "s|^database_id = \".*\"|database_id = \"$DB_ID\"|" "$LIB" > "$tmp" && mv "$tmp" "$LIB"
  grep -E '^(ACCESS_TEAM_DOMAIN|ACCESS_AUD|CF_ACCOUNT_ID|database_id) ' "$LIB"
fi
echo "done. Next: sh $ROOT/scripts/deploy.sh $ENV_DIR"
