#!/usr/bin/env bash
# Test for the "Write SHA256SUMS" step of .github/workflows/release-checksums.yml.
# The step's shell is pulled out of the workflow file and run against a fake
# `gh` that serves release assets from a folder, so nothing touches GitHub.
# Then scripts/install-linux.sh is run against the file it produced.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/release-checksums.yml"
INSTALLER="$REPO_ROOT/scripts/install-linux.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$*"; }

# The step is the last one in the file: take everything after its `run: |`.
awk '/run: \|/ { grab = 1; next } grab { sub(/^          /, ""); print }' "$WORKFLOW" > "$TMP/step.sh"
[[ -s "$TMP/step.sh" ]] || fail "could not read the step from $WORKFLOW"
bash -n "$TMP/step.sh" || fail "the step is not valid shell"

# Fake gh: `release view`, `release download --pattern ...`, `release upload`.
mkdir -p "$TMP/bin" "$TMP/assets" "$TMP/uploaded"
cat > "$TMP/bin/gh" <<'GH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == release ]] || exit 2
sub="$2"; shift 2
case "$sub" in
  view)
    [[ "${FAKE_NO_RELEASE:-0}" != 1 ]]
    ;;
  download)
    shift # tag
    pats=()
    while [[ $# -gt 0 ]]; do
      case "$1" in --pattern) pats+=("$2"); shift 2 ;; *) shift ;; esac
    done
    got=0
    for f in "$FAKE_ASSETS"/*; do
      [[ -e "$f" ]] || continue
      for p in "${pats[@]}"; do
        # shellcheck disable=SC2053
        if [[ "$(basename "$f")" == $p ]]; then cp "$f" .; got=1; break; fi
      done
    done
    [[ $got == 1 ]] || { echo "no assets match" >&2; exit 1; }
    ;;
  upload)
    shift # tag
    cp "$1" "$FAKE_UPLOAD/"
    ;;
  *) exit 2 ;;
esac
GH
chmod +x "$TMP/bin/gh"

run_step() { # <tag>
  PATH="$TMP/bin:$PATH" TAG="$1" FAKE_ASSETS="$TMP/assets" FAKE_UPLOAD="$TMP/uploaded" bash "$TMP/step.sh"
}

# 1. Assets from all three platforms, plus files that must not be listed.
for n in SparkDown_0.4.6_amd64.AppImage SparkDown_0.4.6_amd64.AppImage.sig \
         SparkDown_0.4.6_amd64.deb SparkDown_0.4.6_aarch64.dmg \
         SparkDown_0.4.6_aarch64.app.tar.gz SparkDown_0.4.6_aarch64.app.tar.gz.sig \
         SparkDown_0.4.6_x64-setup.exe SparkDown_0.4.6_x64-setup.exe.sig; do
  printf 'content of %s\n' "$n" > "$TMP/assets/$n"
done
printf '{}' > "$TMP/assets/latest.json"
printf 'old\n' > "$TMP/assets/SHA256SUMS"
run_step v0.4.6 > "$TMP/out1" 2>&1 || fail "step failed: $(cat "$TMP/out1")"
SUMS="$TMP/uploaded/SHA256SUMS"
[[ -f "$SUMS" ]] || fail "no SHA256SUMS uploaded"
[[ "$(wc -l < "$SUMS")" -eq 8 ]] || fail "expected 8 lines: $(cat "$SUMS")"
grep -q latest.json "$SUMS" && fail "latest.json must not be listed"
(cd "$TMP/assets" && sha256sum -c "$SUMS" >/dev/null) || fail "sums do not verify the assets"
pass "SHA256SUMS lists all 8 artifacts and verifies with sha256sum -c"

# 2. The installer uses it: matching .deb passes, a changed one is rejected.
make_fake_deb() {
  local out="$1" work
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
rm -f "$TMP/assets/"*; mkdir -p "$TMP/dl"
make_fake_deb "$TMP/assets/SparkDown_0.4.6_amd64.deb"
printf 'x' > "$TMP/assets/SparkDown_0.4.6_x64-setup.exe"
rm -f "$TMP/uploaded/SHA256SUMS"
run_step v0.4.6 >/dev/null 2>&1
cp "$TMP/assets/SparkDown_0.4.6_amd64.deb" "$TMP/uploaded/SHA256SUMS" "$TMP/dl/"
SPARKDOWN_VERIFY_ONLY=1 bash "$INSTALLER" "$TMP/dl/SparkDown_0.4.6_amd64.deb" >"$TMP/o2" 2>&1 \
  || fail "installer rejected a matching .deb: $(cat "$TMP/o2")"
grep -q 'verified sha256 .* against .*SHA256SUMS' "$TMP/o2" || fail "installer did not use SHA256SUMS: $(cat "$TMP/o2")"
pass "install-linux.sh verifies the .deb against the generated SHA256SUMS"
printf 'changed' >> "$TMP/dl/SparkDown_0.4.6_amd64.deb"
set +e
SPARKDOWN_VERIFY_ONLY=1 bash "$INSTALLER" "$TMP/dl/SparkDown_0.4.6_amd64.deb" >"$TMP/o3" 2>&1
rc=$?
set -e
[[ $rc -ne 0 ]] || fail "installer accepted a changed .deb"
grep -q 'sha256 mismatch' "$TMP/o3" || fail "no mismatch message: $(cat "$TMP/o3")"
pass "install-linux.sh stops when the .deb does not match SHA256SUMS"

# 3. No Release yet, no artifacts yet, or a bad tag.
rm -f "$TMP/uploaded/SHA256SUMS"
FAKE_NO_RELEASE=1 run_step v0.4.6 >/dev/null 2>&1 || fail "a missing Release should not fail the run"
[[ ! -e "$TMP/uploaded/SHA256SUMS" ]] || fail "uploaded without a Release"
pass "no Release yet: nothing uploaded, run succeeds"
rm -f "$TMP/assets/"*
run_step v0.4.6 >/dev/null 2>&1 || fail "no artifacts should not fail the run"
[[ ! -e "$TMP/uploaded/SHA256SUMS" ]] || fail "uploaded an empty list"
pass "no artifacts yet: nothing uploaded, run succeeds"
set +e
run_step 'v0.4.6; echo hi' >/dev/null 2>&1
rc=$?
set -e
[[ $rc -ne 0 ]] || fail "a tag with extra text was accepted"
pass "a tag that is not vX.Y.Z is rejected"

echo "ALL TESTS PASSED"
