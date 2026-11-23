#!/usr/bin/env bash
# Test for the bundle check in scripts/install-linux.sh:
#   * a bundle whose sha256 does not match the given value or a sibling
#     .sha256 file is rejected before anything is installed;
#   * a matching bundle passes;
#   * with nothing to check against it warns and passes, or is rejected
#     when SPARKDOWN_REQUIRE_VERIFY=1.
#
# Runs in verify-only mode so it does not need root or $PREFIX writes.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/install-linux.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$*"; }

make_fake_deb() {
  local out="$1"
  local work
  work="$(mktemp -d)"
  (
    cd "$work"
    printf '2.0\n' > debian-binary
    mkdir -p pkg/usr/bin
    printf '#!/bin/sh\necho hi\n' > pkg/usr/bin/sparkdown
    chmod 755 pkg/usr/bin/sparkdown
    (cd pkg && tar -czf ../data.tar.gz ./usr) >/dev/null
    mkdir -p ctrl
    printf 'Package: sparkdown\nVersion: 0.0.0\nArchitecture: amd64\nMaintainer: t <t@t>\nDescription: t\n' > ctrl/control
    (cd ctrl && tar -czf ../control.tar.gz ./control) >/dev/null
    ar rc "$out" debian-binary control.tar.gz data.tar.gz
  )
  rm -rf "$work"
}

DEB="$TMP/sparkdown_test.deb"
make_fake_deb "$DEB"

GOOD_SHA="$(sha256sum "$DEB" | awk '{print $1}')"
BAD_SHA="0000000000000000000000000000000000000000000000000000000000000000"

set +e
SPARKDOWN_VERIFY_ONLY=1 SPARKDOWN_SHA256="$BAD_SHA" \
  bash "$SCRIPT" "$DEB" >"$TMP/out1" 2>"$TMP/err1"
rc=$?
set -e
[[ $rc -ne 0 ]] || fail "wrong SPARKDOWN_SHA256 was accepted"
grep -q 'sha256 mismatch' "$TMP/err1" || fail "no mismatch message: $(cat "$TMP/err1")"
pass "wrong SPARKDOWN_SHA256 is rejected"

SPARKDOWN_VERIFY_ONLY=1 bash "$SCRIPT" "$DEB" >"$TMP/out2" 2>"$TMP/err2"
grep -q 'WARNING: no signature or checksum' "$TMP/out2" || fail "no warning: $(cat "$TMP/out2")"
pass "bundle with no checksum/signature warns and passes"

set +e
SPARKDOWN_VERIFY_ONLY=1 SPARKDOWN_REQUIRE_VERIFY=1 bash "$SCRIPT" "$DEB" >"$TMP/out2b" 2>"$TMP/err2b"
rc=$?
set -e
[[ $rc -ne 0 ]] || fail "unchecked bundle was accepted with SPARKDOWN_REQUIRE_VERIFY=1"
grep -q 'refusing to install' "$TMP/err2b" || fail "no refusal: $(cat "$TMP/err2b")"
pass "bundle with no checksum/signature is rejected with SPARKDOWN_REQUIRE_VERIFY=1"

SPARKDOWN_VERIFY_ONLY=1 SPARKDOWN_SHA256="$GOOD_SHA" \
  bash "$SCRIPT" "$DEB" >"$TMP/out3" 2>"$TMP/err3"
grep -q 'verified sha256' "$TMP/out3" || fail "no verification log: $(cat "$TMP/out3")"
pass "correct SPARKDOWN_SHA256 passes verification"

printf '%s  %s\n' "$GOOD_SHA" "$(basename "$DEB")" > "$DEB.sha256"
SPARKDOWN_VERIFY_ONLY=1 bash "$SCRIPT" "$DEB" >"$TMP/out4" 2>"$TMP/err4"
grep -q 'verified sha256' "$TMP/out4" || fail "no verification log: $(cat "$TMP/out4")"
pass "sibling .sha256 passes verification"

printf '%s  %s\n' "$BAD_SHA" "$(basename "$DEB")" > "$DEB.sha256"
set +e
SPARKDOWN_VERIFY_ONLY=1 bash "$SCRIPT" "$DEB" >"$TMP/out5" 2>"$TMP/err5"
rc=$?
set -e
[[ $rc -ne 0 ]] || fail "wrong sibling .sha256 was accepted"
grep -q 'sha256 mismatch' "$TMP/err5" || fail "no mismatch: $(cat "$TMP/err5")"
pass "wrong sibling .sha256 is rejected"

echo "ALL TESTS PASSED"
