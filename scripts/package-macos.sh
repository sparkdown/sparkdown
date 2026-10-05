#!/bin/bash
set -e
cd "$(dirname "$0")/.."

# Updater artifact: the signed SparkDown.app.tar.gz that the in-app updater
# (src-tauri/src/updates.rs) installs. It is made at the end of this script
# with our own tar + `tauri signer sign` (--app-version binds the version into
# the signature), so Tauri's createUpdaterArtifacts stays off. Only when
# TAURI_SIGNING_PRIVATE_KEY is set, e.g. by scripts/release.sh; a plain dev
# package run needs no key.
#
# The key is taken out of the environment for the build itself (which runs
# npm/vite and their plugins) and handed only to `tauri signer sign` below.
SIGN_KEY="${TAURI_SIGNING_PRIVATE_KEY:-}"
SIGN_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
frontend/node_modules/.bin/tauri build "$@"

# macOS file associations come from src-tauri/Info.plist, which Tauri merges
# into the bundle's Info.plist at build time. It REPLACES the
# CFBundleDocumentTypes array generated from tauri.conf.json fileAssociations,
# so every document type must be listed there (tauri.conf.json still drives
# the Linux .desktop MIME types). Declaring them at build time means the .app,
# the DMG and the updater tarball all carry the same types.
APP="src-tauri/target/release/bundle/macos/SparkDown.app"
PLIST="$APP/Contents/Info.plist"

# --- Updater artifact (signed .app.tar.gz) ------------------------------------
# Tarball of the built .app (one top-level SparkDown.app directory). The
# minisign signature binds the app version (--app-version); the app refuses an
# update whose signed version differs from the one latest.json announces.
UPDATER_TGZ="src-tauri/target/release/bundle/macos/SparkDown.app.tar.gz"
rm -f "$UPDATER_TGZ" "$UPDATER_TGZ.sig"
if [ -d "$APP" ] && [ -n "$SIGN_KEY" ]; then
  APP_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$PLIST")
  COPYFILE_DISABLE=1 tar -czf "$UPDATER_TGZ" -C "$(dirname "$APP")" "$(basename "$APP")"
  # Key + password go through the environment (never the command line, where
  # `ps` could see them).
  TAURI_SIGNING_PRIVATE_KEY="$SIGN_KEY" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$SIGN_PASSWORD" \
    frontend/node_modules/.bin/tauri signer sign --app-version "$APP_VERSION" "$UPDATER_TGZ" >/dev/null
  echo "Signed updater artifact: $UPDATER_TGZ(.sig) for v$APP_VERSION"
else
  echo "Updater artifact skipped (TAURI_SIGNING_PRIVATE_KEY not set)"
fi
