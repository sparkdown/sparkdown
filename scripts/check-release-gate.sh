#!/bin/bash
# Release gate for the test-only `e2e-webdriver` cargo feature (E2E on
# Windows). Shipped builds must never enable it:
#   1. no workflow (other than e2e.yml) or script mentions it;
#   2. with a binary argument, that binary must not contain the env var
#      name the feature reads (it is compiled out of default builds).
# Usage: scripts/check-release-gate.sh [path/to/sparkdown-binary ...]
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
# Every workflow except the E2E one, and every script except this gate:
# a new release/package workflow is covered without editing this list.
release_files=()
for f in .github/workflows/*.yml .github/workflows/*.yaml scripts/*; do
  case "$f" in
    .github/workflows/e2e.yml | scripts/check-release-gate.sh) continue ;;
  esac
  release_files+=("$f")
done
for f in "${release_files[@]}"; do
  [ -f "$f" ] || continue
  if grep -n -e 'e2e-webdriver' -e 'SPARKDOWN_E2E_WEBVIEW2_ARGS' "$f"; then
    echo "::error file=$f::release path enables or mentions the test-only e2e-webdriver feature"
    fail=1
  fi
done
# The feature must stay off by default. Use cargo metadata instead of grep
# so multi-line default arrays are handled correctly.
if command -v jq >/dev/null; then
  default_features=$(cd src-tauri && cargo metadata --no-deps --format-version 1 | \
    jq -r '(.packages[] | select(.name=="sparkdown") | .features.default // []) | .[]')
  if echo "$default_features" | grep -qF 'e2e-webdriver'; then
    echo "::error file=src-tauri/Cargo.toml::e2e-webdriver is in the default features"
    fail=1
  fi
else
  # Fallback for environments without jq: use the old grep method (works for single-line only).
  if sed -n '/^\[features\]/,/^\[/p' src-tauri/Cargo.toml | grep -E '^default *=.*e2e-webdriver'; then
    echo "::error file=src-tauri/Cargo.toml::e2e-webdriver is in the default features"
    fail=1
  fi
fi
for bin in "$@"; do
  if [ ! -f "$bin" ]; then
    echo "::error::$bin does not exist or is not a file"
    fail=1
    continue
  fi
  if grep -a -q 'SPARKDOWN_E2E_WEBVIEW2_ARGS' "$bin"; then
    echo "::error::$bin contains the e2e-webdriver code path (SPARKDOWN_E2E_WEBVIEW2_ARGS)"
    fail=1
  else
    echo "OK: $bin has no e2e-webdriver code path"
  fi
done
[ "$fail" = 0 ] && echo "OK: release workflows and scripts never enable e2e-webdriver"
exit "$fail"
