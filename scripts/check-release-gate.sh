#!/bin/bash
# Release gate for the test-only `e2e-webdriver` cargo feature (E2E on
# Windows). Shipped builds must never enable it:
#   1. no release/package workflow or packaging script mentions it;
#   2. with a binary argument, that binary must not contain the env var
#      name the feature reads (it is compiled out of default builds).
# Usage: scripts/check-release-gate.sh [path/to/sparkdown-binary ...]
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
release_files=(
  .github/workflows/windows-package.yml
  .github/workflows/linux-package.yml
  .github/workflows/pages.yml
  scripts/package-macos.sh
  scripts/package-windows.ps1
  scripts/release.sh
)
for f in "${release_files[@]}"; do
  [ -f "$f" ] || continue
  if grep -n -e 'e2e-webdriver' -e 'SPARKDOWN_E2E_WEBVIEW2_ARGS' "$f"; then
    echo "::error file=$f::release path enables or mentions the test-only e2e-webdriver feature"
    fail=1
  fi
done
# The feature must stay off by default.
if sed -n '/^\[features\]/,/^\[/p' src-tauri/Cargo.toml | grep -E '^default *=.*e2e-webdriver'; then
  echo "::error file=src-tauri/Cargo.toml::e2e-webdriver is in the default features"
  fail=1
fi
for bin in "$@"; do
  if grep -a -q 'SPARKDOWN_E2E_WEBVIEW2_ARGS' "$bin"; then
    echo "::error::$bin contains the e2e-webdriver code path (SPARKDOWN_E2E_WEBVIEW2_ARGS)"
    fail=1
  else
    echo "OK: $bin has no e2e-webdriver code path"
  fi
done
[ "$fail" = 0 ] && echo "OK: release workflows and scripts never enable e2e-webdriver"
exit "$fail"
