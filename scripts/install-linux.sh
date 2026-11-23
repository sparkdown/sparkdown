#!/usr/bin/env bash
# Install a prebuilt SparkDown Linux binary into PREFIX (default: ~/.local).
# Does not build from source.
#
# Default is the thin ELF from the .deb (system WebKitGTK), never an AppImage
# copied onto PATH.
#
# Integrity: before installing, the script checks the bundle against the
# first of these it finds:
#   * a minisign .sig signed with the updater key
#     (src-tauri/updater-pubkey.txt) next to the bundle, or fetched with a
#     Release asset, when minisign is on PATH;
#   * an expected sha256 passed as --sha256 <hex> or SPARKDOWN_SHA256;
#   * a sibling <bundle>.sha256 or SHA256SUMS file (local, or fetched from
#     the Release with the asset).
# A mismatch stops the install. With none of them, it warns and installs;
# SPARKDOWN_REQUIRE_VERIFY=1 makes that an error instead. Set
# SPARKDOWN_SKIP_VERIFY=1 to skip the check (local test builds).
#
# Usage:
#   bash scripts/install-linux.sh [path-to-deb-or-elf] [--sha256 <hex>]
#   SPARKDOWN_TAG=v0.3.0 SPARKDOWN_SHA256=<hex> bash scripts/install-linux.sh
#
# Looks for, in order:
#   1. The file passed as $1
#   2. SPARKDOWN_BUNDLE env
#   3. A GitHub Release .deb (needs a public release, or gh / GH_TOKEN)
set -euo pipefail

PREFIX="${PREFIX:-$HOME/.local}"
REPO="${SPARKDOWN_REPO:-sparkdown/sparkdown}"
TAG="${SPARKDOWN_TAG:-}"
BIN_DIR="${PREFIX}/bin"
APP_DIR="${PREFIX}/share/applications"
ICON_DIR="${PREFIX}/share/icons/hicolor/128x128/apps"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPDATER_PUBKEY_FILE="${SPARKDOWN_UPDATER_PUBKEY:-$SCRIPT_DIR/../src-tauri/updater-pubkey.txt}"

EXPECTED_SHA256="${SPARKDOWN_SHA256:-}"
BUNDLE_ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --sha256)
      EXPECTED_SHA256="${2:?--sha256 requires a 64-char hex value}"
      shift 2
      ;;
    --sha256=*)
      EXPECTED_SHA256="${1#--sha256=}"
      shift
      ;;
    --)
      shift
      BUNDLE_ARG="${1:-}"
      break
      ;;
    -*)
      printf 'install-linux: error: unknown option %q\n' "$1" >&2
      exit 1
      ;;
    *)
      BUNDLE_ARG="$1"
      shift
      ;;
  esac
done

say() { printf 'install-linux: %s\n' "$*"; }
die() { printf 'install-linux: error: %s\n' "$*" >&2; exit 1; }

find_bundle() {
  if [[ -n "${1:-}" && -f "$1" ]]; then
    echo "$1"
    return
  fi
  if [[ -n "${SPARKDOWN_BUNDLE:-}" && -f "$SPARKDOWN_BUNDLE" ]]; then
    echo "$SPARKDOWN_BUNDLE"
    return
  fi
  return 1
}

download_release() {
  local pattern='*.deb'
  if command -v gh >/dev/null 2>&1; then
    local args=(release download --repo "$REPO" --pattern "$pattern" --dir "$TMP")
    # Best-effort fetch of matching integrity artifacts next to the .deb.
    # Older releases may not have them; verify_bundle decides what to do.
    local sig_args=(release download --repo "$REPO" \
      --pattern '*.deb.sig' --pattern '*.deb.sha256' \
      --pattern 'SHA256SUMS' --pattern 'SHA256SUMS.sig' \
      --dir "$TMP")
    if [[ -n "$TAG" ]]; then
      args+=("$TAG")
      sig_args+=("$TAG")
    else
      args+=(--latest)
      sig_args+=(--latest)
    fi
    if gh "${args[@]}" >/dev/null; then
      gh "${sig_args[@]}" >/dev/null 2>&1 || true
      local f
      f="$(find "$TMP" -maxdepth 1 -name '*.deb' -print -quit)"
      [[ -n "$f" ]] && { echo "$f"; return; }
    fi
  fi
  return 1
}

# Compute the sha256 (hex, lowercase) of a file.
sha256_of() {
  local f="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$f" | awk '{print $1}'
  else
    die "need sha256sum or shasum to verify $f"
  fi
}

# Look up the expected sha256 for basename $1 inside checksum file $2.
# Supports a single bare 64-hex-char line and the standard sha256sum
# `<hex>  <name>` format (match by basename). Prints the hex on match.
sha256_from_file() {
  local target_base="$1"
  local checksum_file="$2"
  [[ -f "$checksum_file" ]] || return 1
  local bare
  bare="$(awk 'NR==1 && $0 ~ /^[0-9a-fA-F]{64}$/ { print tolower($0); exit } { exit }' "$checksum_file")"
  if [[ -n "$bare" ]]; then
    echo "$bare"
    return 0
  fi
  local line
  line="$(awk -v name="$target_base" '
    {
      hex = $1
      sub(/^\*/, "", $2)
      file = $2
      sub(/.*\//, "", file)
      if (file == name && hex ~ /^[0-9a-fA-F]{64}$/) {
        print tolower(hex)
        exit 0
      }
    }
  ' "$checksum_file")"
  [[ -n "$line" ]] || return 1
  echo "$line"
}

# Try to verify $1 with a minisign .sig signed by the updater key.
# Returns 0 on verified, 1 when verification was not attempted (no sig,
# no minisign tool); exits non-zero on a hard verification failure.
try_minisign_verify() {
  local bundle="$1"
  local sig="${bundle}.sig"
  [[ -f "$sig" ]] || return 1
  if ! command -v minisign >/dev/null 2>&1; then
    say "note: $sig present but minisign is not installed; falling back to sha256 verification"
    return 1
  fi
  [[ -f "$UPDATER_PUBKEY_FILE" ]] || die "updater public key file not found: $UPDATER_PUBKEY_FILE"
  # The project stores the pubkey as the base64 of a minisign .pub file
  # (the Tauri updater format). Decode to the actual .pub content for
  # `minisign -V -p`. Fall back to a direct copy if it is already .pub.
  local pub_decoded="$TMP/updater-pubkey.pub"
  if ! base64 -d < "$UPDATER_PUBKEY_FILE" > "$pub_decoded" 2>/dev/null; then
    cp "$UPDATER_PUBKEY_FILE" "$pub_decoded"
  fi
  if ! minisign -V -p "$pub_decoded" -x "$sig" -m "$bundle" >/dev/null 2>&1; then
    die "minisign signature verification failed for $bundle (sig=$sig, pubkey=$UPDATER_PUBKEY_FILE)"
  fi
  say "verified minisign signature for $(basename "$bundle") against $UPDATER_PUBKEY_FILE"
  return 0
}

# Check the bundle before anything is unpacked or installed: stop on a
# signature or checksum mismatch; with nothing to check against, warn (or
# stop when SPARKDOWN_REQUIRE_VERIFY=1). SPARKDOWN_SKIP_VERIFY=1 skips it.
verify_bundle() {
  local bundle="$1"
  if [[ "${SPARKDOWN_SKIP_VERIFY:-0}" == "1" ]]; then
    say "WARNING: SPARKDOWN_SKIP_VERIFY=1 set; installing $bundle without integrity verification"
    return 0
  fi

  if try_minisign_verify "$bundle"; then
    return 0
  fi

  local actual base
  actual="$(sha256_of "$bundle")"
  base="$(basename "$bundle")"

  if [[ -n "$EXPECTED_SHA256" ]]; then
    local want
    want="$(printf '%s' "$EXPECTED_SHA256" | tr 'A-F' 'a-f' | tr -d '[:space:]')"
    [[ "$want" =~ ^[0-9a-f]{64}$ ]] || die "SPARKDOWN_SHA256 / --sha256 must be a 64-char hex sha256 digest, got: $EXPECTED_SHA256"
    if [[ "$actual" != "$want" ]]; then
      die "sha256 mismatch for $bundle: expected $want, got $actual"
    fi
    say "verified sha256 of $base against expected value ($actual)"
    return 0
  fi

  local dir candidate expected
  dir="$(cd "$(dirname "$bundle")" && pwd)"
  for candidate in "${bundle}.sha256" "${dir}/SHA256SUMS" "${dir}/sha256sums.txt"; do
    if expected="$(sha256_from_file "$base" "$candidate")"; then
      if [[ "$actual" != "$expected" ]]; then
        die "sha256 mismatch for $bundle: $candidate says $expected, got $actual"
      fi
      say "verified sha256 of $base against $candidate ($actual)"
      return 0
    fi
  done

  local how="Provide one of:
  * a minisign signature '${base}.sig' signed by the updater key
    ($UPDATER_PUBKEY_FILE), with 'minisign' installed, or
  * an expected sha256: --sha256 <hex> or SPARKDOWN_SHA256=<hex> bash scripts/install-linux.sh ...
  * a sibling checksum file: '${base}.sha256' or 'SHA256SUMS' next to the bundle."
  if [[ "${SPARKDOWN_REQUIRE_VERIFY:-0}" == "1" ]]; then
    die "refusing to install $bundle: nothing to check it against (SPARKDOWN_REQUIRE_VERIFY=1).
$how"
  fi
  say "WARNING: no signature or checksum found for $base; installing it unchecked (sha256 $actual)."
  say "$how"
  return 0
}

unpack_deb() {
  local deb="$1"
  local unpack="$2"
  mkdir -p "$unpack"
  if command -v dpkg-deb >/dev/null 2>&1; then
    dpkg-deb -x "$deb" "$unpack"
    return
  fi
  local abs
  abs="$(cd "$(dirname "$deb")" && pwd)/$(basename "$deb")"
  command -v ar >/dev/null 2>&1 || die "need dpkg-deb or ar to unpack $deb"
  (
    cd "$unpack"
    ar x "$abs"
    local data
    data="$(ls data.tar.* 2>/dev/null | head -n 1)"
    [[ -n "$data" ]] || die "deb has no data.tar.*: $deb"
    tar -xf "$data"
  )
}

install_thin_binary() {
  local src="$1"
  local dest="$2"
  local base
  base="$(basename "$src")"
  case "$base" in
    *.AppImage|*.appimage)
      die "refusing to install an AppImage as sparkdown on PATH. Pass a .deb (or the extracted usr/bin/sparkdown ELF) instead. The AppImage is a portable bundle; the default install is the thin binary from the .deb, which uses system WebKitGTK."
      ;;
    *.deb)
      local unpack="$TMP/deb"
      unpack_deb "$src" "$unpack"
      local bin
      bin="$(find "$unpack" -type f -path '*/usr/bin/sparkdown' -print -quit)"
      [[ -n "$bin" && -f "$bin" ]] || die "deb did not contain usr/bin/sparkdown: $src"
      install -m 755 "$bin" "$dest"
      ;;
    *)
      install -m 755 "$src" "$dest"
      ;;
  esac
}

BUNDLE=""
if BUNDLE="$(find_bundle "$BUNDLE_ARG")"; then
  say "using local bundle $BUNDLE"
elif BUNDLE="$(download_release)"; then
  say "downloaded $BUNDLE"
else
  die "no Linux .deb / binary found. Need a path to a SparkDown .deb (or extracted usr/bin/sparkdown), SPARKDOWN_BUNDLE, or a GitHub Release *.deb. Produce the asset with Actions workflow Linux package. Install from the .deb, not the AppImage. While the repo is private: gh run download --repo ${REPO} --name sparkdown-linux"
fi

verify_bundle "$BUNDLE"

# Verify-only mode for tests: stop after verification so tests can assert
# the integrity decision without touching $PREFIX.
if [[ "${SPARKDOWN_VERIFY_ONLY:-0}" == "1" ]]; then
  say "verify-only mode: integrity check succeeded for $BUNDLE; not installing"
  exit 0
fi

mkdir -p "$BIN_DIR" "$APP_DIR" "$ICON_DIR"
install_thin_binary "$BUNDLE" "$BIN_DIR/sparkdown"

DESKTOP_SRC=""
if [[ -f "$SCRIPT_DIR/../packaging/linux/sparkdown.desktop" ]]; then
  DESKTOP_SRC="$SCRIPT_DIR/../packaging/linux/sparkdown.desktop"
fi
if [[ -n "$DESKTOP_SRC" ]]; then
  sed "s|^Exec=.*|Exec=${BIN_DIR}/sparkdown %F|" "$DESKTOP_SRC" > "$APP_DIR/sparkdown.desktop"
else
  printf '%s\n' \
    '[Desktop Entry]' \
    'Type=Application' \
    'Name=SparkDown' \
    'Comment=Lightweight markdown editor' \
    "Exec=${BIN_DIR}/sparkdown %F" \
    'Icon=sparkdown' \
    'Terminal=false' \
    'Categories=Office;TextEditor;Development;' \
    'StartupWMClass=sparkdown' \
    > "$APP_DIR/sparkdown.desktop"
fi

ICON_SRC="$SCRIPT_DIR/../src-tauri/icons/128x128.png"
if [[ -f "$ICON_SRC" ]]; then
  install -m 644 "$ICON_SRC" "$ICON_DIR/sparkdown.png"
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APP_DIR" >/dev/null 2>&1 || true
fi

say "installed ${BIN_DIR}/sparkdown (thin binary; uses system WebKitGTK)"
say "desktop file ${APP_DIR}/sparkdown.desktop"
say "try: sparkdown    or    sparkdown ~/notes"
