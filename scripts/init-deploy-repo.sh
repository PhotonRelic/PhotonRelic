#!/bin/sh
# Creates a private deployment repository for one or more PhotonRelic
# environments: PhotonRelic as a git submodule pinned to a commit, an
# environment directory filled in from deploy/example, wrapper scripts, a
# package.json and a README. Nothing in it is secret; the identifiers that
# provision.sh writes into it belong to one account, which is why the
# repository is private and separate from this public one.
#
#   sh scripts/init-deploy-repo.sh <dir> --name <env> \
#       --library-host media-admin.example.com --resizer-host img.example.com \
#       [--source <git url>] [--ref <commit>]
#
# --source is the repository the submodule points at: the public project
# (default), your GitHub fork, or a private mirror. --ref is the commit to
# pin; the default is the commit of this checkout. <dir> must not exist or
# must be empty. The result is staged and not committed, so you can read it
# first. Then, inside <dir>: cp .env.example .env, fill it in, and run
# pnpm setup, pnpm preflight <env>, pnpm provision <env>, pnpm deploy <env>,
# pnpm verify <env>.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DIR=""; NAME=""; LIB_HOST=""; RES_HOST=""; SOURCE="https://github.com/PhotonRelic/PhotonRelic.git"; REF=""
usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME=${2:?}; shift 2 ;;
    --library-host) LIB_HOST=${2:?}; shift 2 ;;
    --resizer-host) RES_HOST=${2:?}; shift 2 ;;
    --source) SOURCE=${2:?}; shift 2 ;;
    --ref) REF=${2:?}; shift 2 ;;
    -h|--help) usage ;;
    -*) echo "init-deploy-repo: unknown option $1" >&2; usage ;;
    *) [ -z "$DIR" ] || { echo "init-deploy-repo: one directory only" >&2; usage; }; DIR=$1; shift ;;
  esac
done
[ -n "$DIR" ] && [ -n "$NAME" ] && [ -n "$LIB_HOST" ] && [ -n "$RES_HOST" ] || usage
case "$NAME" in *[!a-z0-9-]*|-*|*-) echo "init-deploy-repo: --name must be lowercase letters, digits and hyphens (it names Workers, the bucket and the database)" >&2; exit 2 ;; esac
for h in "$LIB_HOST" "$RES_HOST"; do case "$h" in *://*|*/*|*example.com) echo "init-deploy-repo: $h is not a bare hostname of yours" >&2; exit 2 ;; esac; done
[ "$LIB_HOST" != "$RES_HOST" ] || { echo "init-deploy-repo: the library and the resizer need different hostnames" >&2; exit 2; }
if [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then echo "init-deploy-repo: $DIR exists and is not empty" >&2; exit 1; fi
[ -n "$REF" ] || REF=$(git -C "$ROOT" rev-parse HEAD)
command -v git >/dev/null 2>&1 || { echo "init-deploy-repo: git is required" >&2; exit 1; }

mkdir -p "$DIR"
DIR=$(CDPATH= cd -- "$DIR" && pwd)
cd "$DIR"
git init -q
echo "== PhotonRelic submodule from $SOURCE at $(printf %s "$REF" | cut -c1-7)"
case "$SOURCE" in
  /*|./*|../*) git -c protocol.file.allow=always submodule add -q -- "$SOURCE" photonrelic ;;
  *) git submodule add -q -- "$SOURCE" photonrelic ;;
esac
git -C photonrelic checkout -q "$REF" 2>/dev/null || { echo "init-deploy-repo: $REF is not in $SOURCE; pass --ref with a commit that is" >&2; exit 1; }
git add photonrelic

echo "== environments/$NAME from deploy/example"
mkdir -p "environments/$NAME"
fill() {
  sed -e "s|photonrelic-example|photonrelic-$NAME|g" \
      -e "s|media-admin\.example\.com|$LIB_HOST|g" \
      -e "s|img\.example\.com|$RES_HOST|g" \
      -e 's|"\.\./\.\./workers/|"../../photonrelic/workers/|g' \
      "$ROOT/deploy/example/$1" > "environments/$NAME/$1"
}
fill library.toml
fill resizer.toml

echo "== scripts, package.json, README"
mkdir -p scripts
for s in preflight provision deploy verify; do
  cat > "scripts/$s.sh" <<WRAP
#!/bin/sh
# Runs PhotonRelic's scripts/$s.sh on an environment here; .env is read from this directory.
#   sh scripts/$s.sh <environment> [options]
set -eu
cd "\$(dirname -- "\$0")/.."
env=\${1:?usage: $s.sh <environment> [options]}; shift
exec sh photonrelic/scripts/$s.sh "environments/\$env" "\$@"
WRAP
  chmod +x "scripts/$s.sh"
done
cat > package.json <<JSON
{
  "name": "photonrelic-deploy",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.13", "pnpm": ">=9" },
  "scripts": {
    "setup": "git submodule update --init && pnpm --dir photonrelic install --frozen-lockfile",
    "check": "sh scripts/deploy.sh $NAME --dry-run",
    "preflight": "sh scripts/preflight.sh",
    "provision": "sh scripts/provision.sh",
    "deploy": "sh scripts/deploy.sh",
    "verify": "sh scripts/verify.sh"
  }
}
JSON
cat > .gitignore <<'IGN'
node_modules/
.wrangler/
.env
.env.*
!.env.example
*.log
.DS_Store
IGN
cp "$ROOT/.env.example" .env.example
cat > README.md <<MD
# photonrelic-deploy

Deployment configuration for [PhotonRelic](https://github.com/PhotonRelic/PhotonRelic)
environments. The application source is the \`photonrelic\` submodule, pinned to
one commit; this repository holds only what is specific to each deployment:
hostnames, bindings, Access settings and the scripts that provision them.
Keep it private: the ids provision.sh writes here belong to one account.

| Environment | Library (staff sign in through Access) | Resizer (public image origin) |
| --- | --- | --- |
| \`$NAME\` | https://$LIB_HOST | https://$RES_HOST |

## Layout

\`\`\`
photonrelic/                       PhotonRelic source (git submodule, pinned)
environments/<name>/library.toml   Wrangler config for the library Worker
environments/<name>/resizer.toml   Wrangler config for the resizer Worker
scripts/{preflight,provision,deploy,verify}.sh   wrappers for photonrelic/scripts/
.env                               credentials (never committed; see .env.example)
\`\`\`

## First deployment

\`\`\`sh
cp .env.example .env            # fill in the token, the account id and the staff email domains
pnpm install && pnpm setup      # submodule and its dependencies
pnpm preflight $NAME            # checks the token, the account and the hostnames; creates nothing
pnpm provision $NAME            # Access application, bucket, database; writes the ids into library.toml
git add environments && git commit -m "$NAME: provisioned"
pnpm check                      # builds both Workers without credentials
pnpm deploy $NAME               # migrations, resizer, library
pnpm verify $NAME               # checks the result from the outside
\`\`\`

The full guide, with the token permissions and the optional features, is
\`photonrelic/docs/deploy.md\`.

## Upgrading PhotonRelic

\`\`\`sh
git -C photonrelic fetch origin && git -C photonrelic log --oneline HEAD..origin/master   # what is new
git -C photonrelic checkout <commit>
pnpm setup && pnpm check
pnpm deploy $NAME && pnpm verify $NAME
git add photonrelic && git commit -m "$NAME: PhotonRelic <commit>"
\`\`\`

Read the commits between for a new variable or binding; add it to
\`environments/$NAME/\` before deploying.

## Another environment

Copy \`environments/$NAME/\` to a new name and change \`name\`, the two route
patterns, \`MEDIA_ORIGIN\`, \`LIBRARY_HOST\`, \`bucket_name\` and
\`database_name\`; reset the \`REPLACE_\` values; then preflight, provision,
deploy and verify it. Environments share nothing.
MD
git add -A
echo
echo "done: $DIR is staged, not committed. Next, in $DIR:"
echo "  cp .env.example .env    # then fill it in"
echo "  pnpm install && pnpm setup"
echo "  pnpm preflight $NAME"
echo "  git commit -m \"PhotonRelic deployment repository for $NAME\""
