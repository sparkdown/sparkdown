#!/usr/bin/env bash
# Install a prebuilt SparkDown Linux binary into PREFIX (default: ~/.local).
# Does not build from source.
#
# Default is the thin ELF from the .deb (system WebKitGTK), never an AppImage
# copied onto PATH.
#
# Usage:
#   bash scripts/install-linux.sh [path-to-deb-or-elf]
#   SPARKDOWN_TAG=v0.3.0 bash scripts/install-linux.sh
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
    if [[ -n "$TAG" ]]; then
      args+=("$TAG")
    else
      args+=(--latest)
    fi
    if gh "${args[@]}" >/dev/null; then
      local f
      f="$(find "$TMP" -maxdepth 1 -name '*.deb' -print -quit)"
      [[ -n "$f" ]] && { echo "$f"; return; }
    fi
  fi
  return 1
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
if BUNDLE="$(find_bundle "${1:-}")"; then
  say "using local bundle $BUNDLE"
elif BUNDLE="$(download_release)"; then
  say "downloaded $BUNDLE"
else
  die "no Linux .deb / binary found. Need a path to a SparkDown .deb (or extracted usr/bin/sparkdown), SPARKDOWN_BUNDLE, or a GitHub Release *.deb. Produce the asset with Actions workflow Linux package. Install from the .deb, not the AppImage. While the repo is private: gh run download --repo ${REPO} --name sparkdown-linux"
fi

mkdir -p "$BIN_DIR" "$APP_DIR" "$ICON_DIR"
install_thin_binary "$BUNDLE" "$BIN_DIR/sparkdown"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
