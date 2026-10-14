#!/usr/bin/env bash
# Bump the Homebrew cask in sparkdown/homebrew-tap to a released version.
# Reads the sha256 of the published SparkDown_<version>_aarch64.dmg from the
# real v<version> GitHub release (downloads it and hashes it), rewrites
# version + sha256 in Casks/sparkdown.rb, and opens a PR against the tap.
# It never creates, edits or deletes releases.
#
# Usage: bash scripts/bump-cask.sh <version> [--direct]
#   --direct  push the commit to the tap's default branch instead of a PR
# Needs: gh authenticated with write access to sparkdown/homebrew-tap
#        (GH_TOKEN works), git, shasum or sha256sum.
set -euo pipefail

VERSION="${1:?usage: bump-cask.sh <version> [--direct]}"
MODE="${2:-pr}"
REPO="${SPARKDOWN_REPO:-sparkdown/sparkdown}"
TAP="${SPARKDOWN_TAP:-sparkdown/homebrew-tap}"
CASK="Casks/sparkdown.rb"
ASSET="SparkDown_${VERSION}_aarch64.dmg"

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "error: version must be X.Y.Z, got '$VERSION'" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> Downloading $ASSET from $REPO v$VERSION"
gh release download "v$VERSION" --repo "$REPO" --pattern "$ASSET" --dir "$TMP"
if command -v sha256sum >/dev/null 2>&1; then
  SHA="$(sha256sum "$TMP/$ASSET" | cut -d' ' -f1)"
else
  SHA="$(shasum -a 256 "$TMP/$ASSET" | cut -d' ' -f1)"
fi
echo "==> sha256 $SHA"

gh repo clone "$TAP" "$TMP/tap" -- -q
cd "$TMP/tap"
sed -i.bak -E "s/^  version \"[^\"]+\"/  version \"$VERSION\"/; s/^  sha256 \"[0-9a-f]+\"/  sha256 \"$SHA\"/" "$CASK"
rm -f "$CASK.bak"
grep -q "version \"$VERSION\"" "$CASK" && grep -q "sha256 \"$SHA\"" "$CASK" || { echo "error: cask rewrite failed" >&2; exit 1; }
if git diff --quiet; then echo "==> cask already at $VERSION"; exit 0; fi

git config user.name "${GIT_AUTHOR_NAME:-paulovitorjp}"
git config user.email "${GIT_AUTHOR_EMAIL:-paulovitorjp@users.noreply.github.com}"
git commit -qam "sparkdown $VERSION"
if [ "$MODE" = "--direct" ]; then
  git push -q origin HEAD
  echo "==> pushed sparkdown $VERSION to $TAP"
else
  BRANCH="bump-sparkdown-$VERSION"
  git push -q origin "HEAD:refs/heads/$BRANCH"
  gh pr create --repo "$TAP" --head "$BRANCH" --title "sparkdown $VERSION" \
    --body "Bump cask to v$VERSION (sha256 of $ASSET from the published release)."
fi
