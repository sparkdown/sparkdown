#!/usr/bin/env bash
# Build GhosttyKit.xcframework (+ terminfo/shell-integration resources) from
# Ghostty source with Zig. Output: native-mac/vendor/{GhosttyKit.xcframework,share}
set -euo pipefail
GHOSTTY_REF="${GHOSTTY_REF:-v1.4.0}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$HERE/.build-ghostty}"
mkdir -p "$WORK" "$HERE/vendor"
if [ ! -d "$WORK/ghostty/.git" ]; then
  git clone --depth 1 --branch "$GHOSTTY_REF" https://github.com/ghostty-org/ghostty "$WORK/ghostty"
fi
cd "$WORK/ghostty"
zig version
# Native (arm64-only) xcframework, no Ghostty.app, ReleaseFast.
zig build \
  -Doptimize=ReleaseFast \
  -Demit-xcframework=true \
  -Demit-macos-app=false \
  -Dxcframework-target=native \
  -Dsentry=false -Di18n=false -Demit-docs=false
rm -rf "$HERE/vendor/GhosttyKit.xcframework" "$HERE/vendor/share"
cp -R macos/GhosttyKit.xcframework "$HERE/vendor/"
mkdir -p "$HERE/vendor/share"
cp -R zig-out/share/ghostty "$HERE/vendor/share/" 2>/dev/null || true
cp -R zig-out/share/terminfo "$HERE/vendor/share/" 2>/dev/null || true
git rev-parse HEAD > "$HERE/vendor/GHOSTTY_COMMIT"
ls -la "$HERE/vendor" "$HERE/vendor/share" || true
find "$HERE/vendor/GhosttyKit.xcframework" -maxdepth 3 | head -20
