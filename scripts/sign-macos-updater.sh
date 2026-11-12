#!/bin/bash
# Sign the macOS updater tarball separately from the build step.
# Usage: sign-macos-updater.sh <version>
# Example: sign-macos-updater.sh 0.4.3
#
# Requires TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD
# in the environment. These are passed only to the tauri signer process,
# never on the command line where ps could see them.
#
# Creates and signs SparkDown_<version>_aarch64.app.tar.gz, the published
# artifact name, so the signature's trusted comment names the file as
# distributed (not an internal build artifact). Older releases signed
# SparkDown.app.tar.gz and renamed it, so their signatures name the
# pre-rename form; the client accepts both for darwin compatibility.

set -e
cd "$(dirname "$0")/.."

VERSION="${1:?usage: sign-macos-updater.sh <version>}"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: version must be semver (X.Y.Z), got '$VERSION'" >&2
  exit 1
fi

if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo "error: TAURI_SIGNING_PRIVATE_KEY is not set"
  exit 1
fi

APP="src-tauri/target/release/bundle/macos/SparkDown.app"
PLIST="$APP/Contents/Info.plist"
UPDATER_TGZ="src-tauri/target/release/bundle/macos/SparkDown_${VERSION}_aarch64.app.tar.gz"

if [ ! -d "$APP" ]; then
  echo "error: $APP not found (run package-macos.sh first)"
  exit 1
fi

APP_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$PLIST")
if [ "$APP_VERSION" != "$VERSION" ]; then
  echo "error: bundle version ($APP_VERSION) != requested version ($VERSION)"
  exit 1
fi

rm -f "$UPDATER_TGZ" "$UPDATER_TGZ.sig"
COPYFILE_DISABLE=1 tar -czf "$UPDATER_TGZ" -C "$(dirname "$APP")" "$(basename "$APP")"

# Key + password go through the environment (never the command line).
frontend/node_modules/.bin/tauri signer sign --app-version "$APP_VERSION" "$UPDATER_TGZ" >/dev/null
echo "Signed updater artifact: $UPDATER_TGZ(.sig) for v$APP_VERSION"
