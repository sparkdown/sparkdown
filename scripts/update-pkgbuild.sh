#!/usr/bin/env bash
# Update the AUR sparkdown-bin PKGBUILD for a release: bump pkgver and fill the
# .deb sha256sum from the actual published (or locally supplied) release asset.
#
# The desktop/icon checksums in the PKGBUILD are for the two static files that
# live next to it and do not change per release; only pkgver and the first
# sha256sums entry (the .deb) are rewritten here.
#
# Usage:
#   bash scripts/update-pkgbuild.sh <version>            # downloads the release .deb via gh
#   bash scripts/update-pkgbuild.sh <version> <deb-path> # uses a local .deb (no download)
#
# Example: bash scripts/update-pkgbuild.sh 0.3.1
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?usage: update-pkgbuild.sh <version> [path-to-deb]}"
DEB="${2:-}"
REPO="${SPARKDOWN_REPO:-sparkdown/sparkdown}"
PKGBUILD="packaging/aur/sparkdown-bin/PKGBUILD"

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: version must be semver (X.Y.Z), got '$VERSION'" >&2
  exit 1
fi
[ -f "$PKGBUILD" ] || { echo "error: $PKGBUILD not found" >&2; exit 1; }

TMP=""
cleanup() { if [ -n "$TMP" ]; then rm -rf "$TMP"; fi; }
trap cleanup EXIT

if [ -z "$DEB" ]; then
  command -v gh >/dev/null 2>&1 || { echo "error: gh CLI required to download the release .deb" >&2; exit 1; }
  TMP="$(mktemp -d)"
  echo "==> Downloading v$VERSION .deb from $REPO"
  gh release download "v$VERSION" --repo "$REPO" --pattern '*_amd64.deb' --dir "$TMP"
  DEB="$(find "$TMP" -maxdepth 1 -name '*.deb' -print -quit)"
  [ -n "$DEB" ] || { echo "error: no .deb found in the v$VERSION release" >&2; exit 1; }
fi
[ -f "$DEB" ] || { echo "error: .deb not found: $DEB" >&2; exit 1; }

# sha256 (portable: sha256sum on Linux, shasum -a 256 on macOS).
if command -v sha256sum >/dev/null 2>&1; then
  SUM="$(sha256sum "$DEB" | awk '{print $1}')"
else
  SUM="$(shasum -a 256 "$DEB" | awk '{print $1}')"
fi
echo "==> .deb sha256: $SUM"

# Rewrite pkgver and the first (the .deb) sha256sums entry. A single Perl pass
# keeps this portable between GNU and BSD sed behavior.
perl -0pi -e "s/^pkgver=.*$/pkgver=$VERSION/m" "$PKGBUILD"
perl -0pi -e "s/(sha256sums=\(')[0-9a-f]{64}'/\${1}$SUM'/" "$PKGBUILD"

echo "==> Updated $PKGBUILD (pkgver=$VERSION, .deb checksum filled)"
grep -nE '^pkgver=|sha256sums=' "$PKGBUILD"
