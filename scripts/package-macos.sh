#!/bin/bash
set -e
cd "$(dirname "$0")/.."

# Build the macOS bundle (SparkDown.app + DMG). The updater tarball
# (SparkDown.app.tar.gz) should be signed separately using
# scripts/sign-macos-updater.sh after the build completes, so the signing
# key is never exposed to the build process tree (npm/vite plugins and
# cargo build.rs scripts). On macOS, the kernel captures the initial
# environment at execve time, and a shell-level unset does not remove
# variables from that captured block, which is visible to same-uid
# descendants via KERN_PROCARGS2 or ps -Eww.
frontend/node_modules/.bin/tauri build "$@"

# macOS file associations come from src-tauri/Info.plist, which Tauri merges
# into the bundle's Info.plist at build time. It REPLACES the
# CFBundleDocumentTypes array generated from tauri.conf.json fileAssociations,
# so every document type must be listed there (tauri.conf.json still drives
# the Linux .desktop MIME types). Declaring them at build time means the .app,
# the DMG and the updater tarball all carry the same types.

# --- Updater artifact (separate signing step) ---------------------------------
# The signed updater tarball (SparkDown.app.tar.gz) is created by running
# scripts/sign-macos-updater.sh after this build completes. That keeps the
# signing key out of the build process tree.
