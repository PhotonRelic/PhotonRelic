#!/bin/sh
# Cuts a release, in two steps run by a maintainer.
#
#   sh scripts/release.sh prepare <version>   on master: makes a release/v<version>
#       branch that sets the version in every package.json and dates the
#       changelog's Unreleased section. Open it as a pull request.
#   sh scripts/release.sh tag <version>       on master after the merge: makes a
#       signed tag v<version> and pushes it. The release workflow does the rest.
#
# <version> is X.Y.Z, or X.Y.Z-rc.N for a release candidate. A candidate is
# tagged on the commit the final version will be tagged on: prepare runs once
# per X.Y.Z, and the package.json files carry X.Y.Z while candidates are cut.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PKGS="package.json workers/library/package.json workers/resizer/package.json packages/media-params/package.json"
usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
die() { echo "release: $*" >&2; exit 1; }
CMD=${1:-}; VERSION=${2:-}
[ -n "$CMD" ] && [ -n "$VERSION" ] || usage
case "$VERSION" in v*) die "give the version without the v: ${VERSION#v}" ;; esac
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$' || die "$VERSION is not X.Y.Z or X.Y.Z-rc.N"
BASE=${VERSION%%-*}
cd "$ROOT"

pkg_version() { node -p 'require(process.argv[1]).version' "$ROOT/$1"; }
changelog_has() { grep -Eq "^## \[$(printf '%s' "$1" | sed 's/\./\\./g')\] - [0-9]{4}-[0-9]{2}-[0-9]{2}\$" CHANGELOG.md; }
on_master() {
  git fetch -q origin master
  [ -z "$(git status --porcelain)" ] || die "the tree is not clean"
  [ "$(git rev-parse --abbrev-ref HEAD)" = master ] || die "run this on master"
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)" ] || die "master is not at origin/master; pull first"
}

case "$CMD" in
  prepare)
    case "$VERSION" in *-*) die "prepare takes the final version ($BASE); candidates are only tagged" ;; esac
    on_master
    [ "$(grep -c '^## \[Unreleased\]$' CHANGELOG.md)" -eq 1 ] || die "CHANGELOG.md needs exactly one '## [Unreleased]' heading"
    ! changelog_has "$VERSION" || die "CHANGELOG.md already has a dated $VERSION section"
    lines=$(awk '/^## \[Unreleased\]$/ { p = 1; next } p && /^## / { exit } p' CHANGELOG.md | grep -c '[^[:space:]]' || true)
    [ "$lines" -gt 0 ] || die "the Unreleased section of CHANGELOG.md is empty; nothing to release"
    ! git show-ref -q --verify "refs/heads/release/v$VERSION" || die "branch release/v$VERSION already exists"
    git checkout -q -b "release/v$VERSION"
    for f in $PKGS; do
      awk -v v="$VERSION" '!d && /"version": "[^"]*"/ { sub(/"version": "[^"]*"/, "\"version\": \"" v "\""); d = 1 } { print }' "$f" > "$f.tmp"
      mv "$f.tmp" "$f"
      [ "$(pkg_version "$f")" = "$VERSION" ] || die "could not set the version in $f"
    done
    today=$(date -u +%Y-%m-%d)
    awk -v v="$VERSION" -v d="$today" '/^## \[Unreleased\]$/ { print; print ""; print "## [" v "] - " d; next } { print }' CHANGELOG.md > CHANGELOG.md.tmp
    mv CHANGELOG.md.tmp CHANGELOG.md
    # shellcheck disable=SC2086
    git add $PKGS CHANGELOG.md
    git -c commit.gpgsign=true commit -q -m "Release v$VERSION"
    git push -q -u origin "release/v$VERSION"
    echo "done: release/v$VERSION is pushed. Open a pull request titled \"Release v$VERSION\" with the"
    echo "CHANGELOG.md section as its description and merge it. Then, on master:"
    echo "  sh scripts/release.sh tag $VERSION-rc.1    # a candidate first, or"
    echo "  sh scripts/release.sh tag $VERSION"
    ;;
  tag)
    on_master
    for f in $PKGS; do
      v=$(pkg_version "$f")
      [ "$v" = "$BASE" ] || die "$f says $v, not $BASE; run: sh scripts/release.sh prepare $BASE"
    done
    changelog_has "$BASE" || die "CHANGELOG.md has no dated $BASE section; run: sh scripts/release.sh prepare $BASE"
    ! git ls-remote --exit-code --tags origin "refs/tags/v$VERSION" >/dev/null 2>&1 || die "v$VERSION already exists on origin; a tag is never moved. Release the next version instead."
    [ -n "$(git config --get user.signingkey)" ] || die "no user.signingkey configured; the tag must be signed"
    git tag -s "v$VERSION" -m "PhotonRelic v$VERSION"
    git push -q origin "refs/tags/v$VERSION"
    echo "done: v$VERSION is pushed."
    case "$(git remote get-url origin)" in
      *github.com*)
        repo=$(git remote get-url origin | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')
        echo "The release workflow is running at https://github.com/$repo/actions/workflows/release.yml"
        echo "and the release will appear at https://github.com/$repo/releases/tag/v$VERSION" ;;
    esac
    ;;
  *) usage ;;
esac
