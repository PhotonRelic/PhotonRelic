#!/bin/sh
# Checks that a release tag is consistent before anything is published, and
# writes its release notes. The release workflow runs it; so can you.
#
#   sh scripts/release-check.sh v1.2.0 [--notes <file>]
#
# Checks: the tag is vX.Y.Z or vX.Y.Z-rc.N, annotated, and signed by a key in
# .github/allowed_signers (release.sh signs it); every package.json carries
# X.Y.Z; CHANGELOG.md has one dated X.Y.Z section (a candidate shares the
# section of the version it leads to); the tagged commit is on master. The
# notes end with a Verify section: the tagged commit and the SHA-256 of
# scripts/install.sh. Prints version=, prerelease=, commit=, sha256= and
# notes= lines, and appends them to $GITHUB_OUTPUT when that is set.
set -eu
. "$(dirname -- "$0")/lib.sh"
usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
TAG=""; NOTES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --notes) NOTES=${2:?}; shift 2 ;;
    -h|--help) usage ;;
    -*) echo "release-check: unknown option $1" >&2; usage ;;
    *) TAG=$1; shift ;;
  esac
done
[ -n "$TAG" ] || TAG=${GITHUB_REF_NAME:-}
[ -n "$TAG" ] || usage
cd "$ROOT"
PKGS="package.json workers/library/package.json workers/resizer/package.json packages/media-params/package.json"
sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

VERSION=${TAG#v}
PRE=false
if printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  pass "$TAG is a release"
elif printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$'; then
  PRE=true; pass "$TAG is a release candidate"
else
  fail "$TAG is not vX.Y.Z or vX.Y.Z-rc.N" "tag with: sh scripts/release.sh tag <version>"
fi
BASE=${VERSION%%-*}

for f in $PKGS; do
  v=$(node -p 'require(process.argv[1]).version' "$ROOT/$f")
  if [ "$v" = "$BASE" ]; then pass "$f is $v"; else fail "$f is $v, not $BASE" "run: sh scripts/release.sh prepare $BASE"; fi
done

re=$(printf '%s' "$BASE" | sed 's/\./\\./g')
n=$(grep -cE "^## \[$re\] - [0-9]{4}-[0-9]{2}-[0-9]{2}\$" CHANGELOG.md || true)
if [ "$n" -eq 1 ]; then pass "CHANGELOG.md has a dated $BASE section"; else fail "CHANGELOG.md has $n dated $BASE sections, not one" "run: sh scripts/release.sh prepare $BASE"; fi

COMMIT=""
if t=$(git cat-file -t "$TAG" 2>/dev/null); then
  if [ "$t" = tag ]; then pass "$TAG is an annotated tag"; else fail "$TAG is a lightweight tag" "delete it and tag with scripts/release.sh, which signs"; fi
  if git -c gpg.ssh.allowedSignersFile="$ROOT/.github/allowed_signers" verify-tag "$TAG" >/dev/null 2>&1; then
    pass "$TAG is signed by a key in .github/allowed_signers"
  else
    fail "$TAG is not signed by a key in .github/allowed_signers" "tag with scripts/release.sh using the maintainer's signing key; a new maintainer's public key is added to .github/allowed_signers by pull request first"
  fi
  COMMIT=$(git rev-parse "$TAG^{commit}")
  if git merge-base --is-ancestor "$COMMIT" origin/master 2>/dev/null; then
    pass "$(printf %s "$COMMIT" | cut -c1-7) is on master"
  else
    fail "$(printf %s "$COMMIT" | cut -c1-7) is not on origin/master" "tag the squash commit on master (release.sh tag checks this)"
  fi
else
  fail "tag $TAG does not exist here" "fetch the tags, or push it with scripts/release.sh tag"
fi
SHA256=$(sha256_of scripts/install.sh)

[ -n "$NOTES" ] || NOTES=$(mktemp "${TMPDIR:-/tmp}/photonrelic-notes.XXXXXX")
{
  if [ "$PRE" = true ]; then
    printf 'Release candidate %s for %s. It is not marked as the latest release; install it with `sh install.sh --version %s` or pin it deliberately.\n\n' "$VERSION" "$BASE" "$TAG"
  fi
  awk -v h="## [$BASE] - " 'index($0, h) == 1 { p = 1; next } p && /^## / { exit } p' CHANGELOG.md | sed -n '/[^[:space:]]/,$p'
  printf '\n## Verify\n\n'
  printf -- '- Tagged commit: `%s`\n' "${COMMIT:-unknown}"
  printf -- '- `install.sh` SHA-256: `%s`\n\n' "$SHA256"
  printf 'Check a downloaded installer with `shasum -a 256 install.sh` (or `sha256sum`). Pin an install to this exact code, so a moved tag cannot change what you run: `sh install.sh --version %s --commit %s`.\n' "$TAG" "${COMMIT:-<commit>}"
} > "$NOTES"
if grep -q '[^[:space:]]' "$NOTES"; then pass "release notes written to $NOTES"; else fail "the $BASE section of CHANGELOG.md is empty" "write it"; fi

printf 'version=%s\nprerelease=%s\ncommit=%s\nsha256=%s\nnotes=%s\n' "$VERSION" "$PRE" "$COMMIT" "$SHA256" "$NOTES" | tee -a "${GITHUB_OUTPUT:-/dev/null}"
printf '\nrelease-check: %d passed, %d failed\n' "$PASS" "$FAILS"
[ "$FAILS" -eq 0 ]
