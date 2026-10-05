#!/bin/bash
# Cut a SparkDown release from this machine (macOS builds are local-only;
# CI covers tests/lints but has no macOS runners by design).
#
# Usage: bash scripts/release.sh <version> [--notes "release notes markdown"]
#        bash scripts/release.sh <version> --manifest-only [--notes "..."]
# Example: bash scripts/release.sh 0.2.0 --notes "$(cat /tmp/notes.md)"
#          bash scripts/release.sh 0.3.1 --notes "$(cat docs/release-notes-0.3.1.md)"
#          (keep docs/release-notes-<version>.md in step with CHANGELOG.md)
#
# Steps: verify clean tree on main -> load the updater signing key -> run full
# test suite -> bump versions (tauri.conf.json, Cargo.toml, package.json) ->
# build + package .dmg and the signed updater .app.tar.gz -> commit, tag
# v<version>, push -> create GitHub release -> wait for the Linux workflow ->
# write + upload latest.json (the auto-update manifest).
#
# Updater signing key: TAURI_SIGNING_PRIVATE_KEY (key content) if set, else
# the file ~/.tauri/sparkdown-updater.key (override: UPDATER_KEY_FILE). The
# password comes from TAURI_SIGNING_PRIVATE_KEY_PASSWORD, or a hidden prompt
# (press Enter for a key without a password). Neither is ever echoed.
#
# latest.json covers two platforms built in two places: darwin-aarch64 (this
# Mac) and linux-x86_64 (the AppImage, built + signed by the tag-triggered
# .github/workflows/linux-package.yml). Only ONE writer exists, to avoid a
# race: this script. After the Linux assets are attached, it downloads BOTH
# .sig files from the release (the release is the source of truth), writes one
# latest.json and uploads it with --clobber. If the Linux signature is missing
# (CI secrets not set, or the workflow is slow), latest.json has only the
# macOS entry; re-run later with --manifest-only to add Linux.
#
# Each platform entry also carries `size` (bytes), read from the release's
# asset list (`gh release view --json assets`), so the app can show a download
# percentage, cap the download and reject a file of the wrong length. For the
# macOS artifact built here, the local `stat -f %z` must match the uploaded
# asset. Older apps ignore the field.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${SPARKDOWN_REPO:-sparkdown/sparkdown}"
VERSION="${1:?usage: release.sh <version> [--notes <markdown>] [--manifest-only]}"
shift
NOTES=""
MANIFEST_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --notes) NOTES="${2:?--notes requires a value}"; shift 2 ;;
    --manifest-only) MANIFEST_ONLY=1; shift ;;
    *) echo "error: unknown argument '$1'" >&2; exit 1 ;;
  esac
done

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: version must be semver (X.Y.Z), got '$VERSION'" >&2
  exit 1
fi

MAC_TGZ_ASSET="SparkDown_${VERSION}_aarch64.app.tar.gz"
APPIMAGE_ASSET="SparkDown_${VERSION}_amd64.AppImage"

# The public key compiled into the app (src-tauri/src/updates.rs).
UPDATER_PUBKEY_FILE="src-tauri/updater-pubkey.txt"
updater_pubkey() {
  tr -d '[:space:]' < "$UPDATER_PUBKEY_FILE"
}

# Fail if the .sig was made by a different key than the pubkey the app ships
# with (the app would reject every update). Compares minisign key IDs.
check_sig_key() {
  python3 - "$(updater_pubkey)" "$1" <<'PY'
import base64, sys

def key_id(tauri_b64):
    text = base64.b64decode(tauri_b64.strip()).decode()
    line = next(l for l in text.splitlines() if l and not l.endswith(":") and "comment:" not in l)
    return base64.b64decode(line)[2:10]

pub, sig = sys.argv[1], open(sys.argv[2]).read()
if key_id(pub) != key_id(sig):
    sys.exit(f"error: {sys.argv[2]} was not signed by the key in src-tauri/updater-pubkey.txt")
PY
}

# Write latest.json from the .sig assets on the release and upload it.
publish_manifest() {
  local tmp
  tmp=$(mktemp -d)
  gh release download "v$VERSION" --repo "$REPO" --dir "$tmp" \
    --pattern "$MAC_TGZ_ASSET.sig" --pattern "$APPIMAGE_ASSET.sig" 2>/dev/null || true
  if [ ! -f "$tmp/$MAC_TGZ_ASSET.sig" ]; then
    echo "error: $MAC_TGZ_ASSET.sig is not on release v$VERSION; cannot write latest.json" >&2
    rm -rf "$tmp"
    return 1
  fi
  # Explicit `|| return`: this function is also called as `publish_manifest ||
  # warn`, where `set -e` does not apply inside it.
  check_sig_key "$tmp/$MAC_TGZ_ASSET.sig" || { rm -rf "$tmp"; return 1; }
  if [ -f "$tmp/$APPIMAGE_ASSET.sig" ]; then
    check_sig_key "$tmp/$APPIMAGE_ASSET.sig" || { rm -rf "$tmp"; return 1; }
  else
    echo "WARNING: $APPIMAGE_ASSET.sig not on the release; latest.json will be macOS-only." >&2
    echo "         Once it is attached: bash scripts/release.sh $VERSION --manifest-only" >&2
  fi
  # Asset sizes (bytes) as GitHub stores them. On failure the manifest is
  # written without sizes (the app then shows MB and skips the length check).
  gh release view "v$VERSION" --repo "$REPO" --json assets > "$tmp/assets.json" 2>/dev/null \
    || echo '{"assets":[]}' > "$tmp/assets.json"
  local notes="${NOTES:-See https://github.com/$REPO/releases/tag/v$VERSION}"
  python3 - "$tmp" "$VERSION" "$REPO" "$notes" "$MAC_TGZ_ASSET" "$APPIMAGE_ASSET" \
    "${MAC_TGZ_LOCAL_SIZE:-}" <<'PY' || { rm -rf "$tmp"; return 1; }
import json, os, sys, datetime
tmp, version, repo, notes, mac, appimage, mac_local = sys.argv[1:8]
base = f"https://github.com/{repo}/releases/download/v{version}"
with open(os.path.join(tmp, "assets.json")) as f:
    sizes = {a["name"]: a.get("size") for a in json.load(f).get("assets", [])}
if mac_local:
    # The artifact built on this Mac must be the one on the release.
    local, uploaded = int(mac_local), sizes.get(mac)
    if uploaded is not None and uploaded != local:
        sys.exit(f"error: {mac} is {uploaded} bytes on the release, {local} locally")
    sizes[mac] = local
def entry(asset):
    with open(os.path.join(tmp, asset + ".sig")) as f:
        e = {"signature": f.read().strip(), "url": f"{base}/{asset}"}
    size = sizes.get(asset)
    if isinstance(size, int) and size > 0:
        e["size"] = size
    else:
        print(f"    WARNING: no size for {asset}; the app will show MB only", file=sys.stderr)
    return e
platforms = {"darwin-aarch64": entry(mac)}
if os.path.exists(os.path.join(tmp, appimage + ".sig")):
    platforms["linux-x86_64"] = entry(appimage)
manifest = {
    "version": version,
    "notes": notes,
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": platforms,
}
with open(os.path.join(tmp, "latest.json"), "w") as f:
    json.dump(manifest, f, indent=2)
print("    platforms:", ", ".join(f"{k} ({v.get('size', '?')} bytes)" for k, v in platforms.items()))
PY
  [ -f "$tmp/latest.json" ] || { rm -rf "$tmp"; return 1; }
  gh release upload "v$VERSION" "$tmp/latest.json" --repo "$REPO" --clobber \
    || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}

if [ "$MANIFEST_ONLY" -eq 1 ]; then
  echo "==> Writing latest.json for v$VERSION from the release's .sig assets"
  publish_manifest
  exit 0
fi

BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "main" ]; then
  echo "error: releases are cut from main (currently on '$BRANCH')" >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree not clean; commit or stash first" >&2
  exit 1
fi
if git rev-parse "v$VERSION" >/dev/null 2>&1; then
  echo "error: tag v$VERSION already exists" >&2
  exit 1
fi

echo "==> Loading the updater signing key"
if [ "$(updater_pubkey)" = "REPLACE_WITH_UPDATER_PUBLIC_KEY" ]; then
  echo "error: $UPDATER_PUBKEY_FILE is still the placeholder." >&2
  echo "       Generate a key pair (npx tauri signer generate -w ~/.tauri/sparkdown-updater.key)" >&2
  echo "       and paste the PUBLIC key (~/.tauri/sparkdown-updater.key.pub) there." >&2
  exit 1
fi
# Kept as plain (unexported) shell variables so the test suite below never
# sees them; only package-macos.sh gets them, and it hands them to the
# signer alone.
SIGN_KEY="${TAURI_SIGNING_PRIVATE_KEY:-}"
if [ -z "$SIGN_KEY" ]; then
  UPDATER_KEY_FILE="${UPDATER_KEY_FILE:-$HOME/.tauri/sparkdown-updater.key}"
  if [ ! -f "$UPDATER_KEY_FILE" ]; then
    echo "error: no updater signing key: set TAURI_SIGNING_PRIVATE_KEY or create $UPDATER_KEY_FILE" >&2
    exit 1
  fi
  SIGN_KEY=$(cat "$UPDATER_KEY_FILE")
fi
if [ -n "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+set}" ]; then
  SIGN_PASSWORD="$TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
elif SIGN_PASSWORD=$(security find-generic-password -a "$USER" -s sparkdown-updater-key -w 2>/dev/null); then
  # Stored by scripts/setup-updater-key.sh (macOS may ask to allow access).
  :
else
  read -rsp "Updater signing key password (Enter if none): " SIGN_PASSWORD </dev/tty
  echo
fi
unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD

echo "==> Running the full check suite (matches CI)"
# Mirror CI so a release can't ship something CI would have failed.
(cd frontend && npx tsc --noEmit && npm test && npm run build && npm audit --audit-level=high)
(cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test)
if command -v cargo-audit >/dev/null 2>&1 || cargo audit --version >/dev/null 2>&1; then
  (cd src-tauri && cargo audit)
else
  echo "warning: cargo-audit not installed; skipping (CI still runs it)" >&2
fi

echo "==> Bumping versions to $VERSION"
# tauri.conf.json drives the bundle; Cargo.toml and package.json follow.
sed -i '' "s/^  \"version\": \".*\",/  \"version\": \"$VERSION\",/" src-tauri/tauri.conf.json
sed -i '' "s/^version = \".*\"/version = \"$VERSION\"/" src-tauri/Cargo.toml
# --allow-same-version so a re-run after a partial release (versions already
# bumped) doesn't abort here.
(cd frontend && npm version "$VERSION" --allow-same-version --no-git-tag-version >/dev/null)
# Refresh Cargo.lock's own-package version entry.
(cd src-tauri && cargo update --workspace --quiet)

echo "==> Building release bundle (+ signed updater artifact)"
TAURI_SIGNING_PRIVATE_KEY="$SIGN_KEY" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$SIGN_PASSWORD" \
  bash scripts/package-macos.sh
unset SIGN_KEY SIGN_PASSWORD

DMG="src-tauri/target/release/bundle/dmg/SparkDown_${VERSION}_aarch64.dmg"
APP="src-tauri/target/release/bundle/macos/SparkDown.app"
UPDATER_TGZ="src-tauri/target/release/bundle/macos/SparkDown.app.tar.gz"
if [ ! -f "$DMG" ]; then
  echo "error: expected $DMG after build" >&2
  exit 1
fi
if [ ! -f "$UPDATER_TGZ" ] || [ ! -f "$UPDATER_TGZ.sig" ]; then
  echo "error: expected $UPDATER_TGZ and .sig after build" >&2
  exit 1
fi
check_sig_key "$UPDATER_TGZ.sig"
# Versioned asset names, so every release's files are distinct.
UPLOAD_DIR=$(mktemp -d)
cp "$UPDATER_TGZ" "$UPLOAD_DIR/$MAC_TGZ_ASSET"
# Checked against the uploaded asset when latest.json is written.
MAC_TGZ_LOCAL_SIZE=$(stat -f %z "$UPLOAD_DIR/$MAC_TGZ_ASSET")
cp "$UPDATER_TGZ.sig" "$UPLOAD_DIR/$MAC_TGZ_ASSET.sig"

echo "==> Committing, tagging v$VERSION, pushing"
git add src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock \
        frontend/package.json frontend/package-lock.json
git commit -m "Release v$VERSION"
git tag "v$VERSION"
git push
git push origin "v$VERSION"

echo "==> Creating GitHub release"
ASSETS_MAC=("$DMG" "$UPLOAD_DIR/$MAC_TGZ_ASSET" "$UPLOAD_DIR/$MAC_TGZ_ASSET.sig")
if [ -n "$NOTES" ]; then
  gh release create "v$VERSION" "${ASSETS_MAC[@]}" --title "SparkDown v$VERSION" --notes "$NOTES"
else
  gh release create "v$VERSION" "${ASSETS_MAC[@]}" --title "SparkDown v$VERSION" --generate-notes
fi
rm -rf "$UPLOAD_DIR"

# The tag push triggers the Linux package workflow, which builds the .deb +
# AppImage and attaches them to this release. Poll until they show up (or warn),
# then refresh the AUR PKGBUILD from the published .deb.
echo "==> Waiting for the Linux package workflow to attach .deb + AppImage"
DEADLINE=$(( $(date +%s) + 20 * 60 ))   # up to 20 minutes
LINUX_READY=0
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  ASSETS=$(gh release view "v$VERSION" --json assets --jq '.assets[].name' 2>/dev/null || true)
  if printf '%s\n' "$ASSETS" | grep -q '\.deb$' && printf '%s\n' "$ASSETS" | grep -q '\.AppImage$'; then
    LINUX_READY=1
    # The AppImage .sig is uploaded in the same step; give it a moment.
    for _ in 1 2 3 4; do
      printf '%s\n' "$ASSETS" | grep -qF "$APPIMAGE_ASSET.sig" && break
      sleep 15
      ASSETS=$(gh release view "v$VERSION" --json assets --jq '.assets[].name' 2>/dev/null || true)
    done
    break
  fi
  echo "    ... not attached yet; checking again in 30s"
  sleep 30
done

if [ "$LINUX_READY" -eq 1 ]; then
  echo "==> Linux assets attached. Updating AUR PKGBUILD from the published .deb"
  bash scripts/update-pkgbuild.sh "$VERSION"
  if [ -n "$(git status --porcelain packaging/aur/sparkdown-bin/PKGBUILD)" ]; then
    git add packaging/aur/sparkdown-bin/PKGBUILD
    git commit -m "Update AUR PKGBUILD for v$VERSION"
    git push
  fi
else
  echo "WARNING: Linux .deb/.AppImage were not attached to v$VERSION within 20 minutes." >&2
  echo "         Check the 'Linux package' workflow run, then once assets are up run:" >&2
  echo "           bash scripts/update-pkgbuild.sh $VERSION && git commit -am 'Update AUR PKGBUILD for v$VERSION' && git push" >&2
fi

echo "==> Writing the auto-update manifest (latest.json)"
publish_manifest || echo "WARNING: latest.json not published; fix, then: bash scripts/release.sh $VERSION --manifest-only" >&2

echo "==> Done: v$VERSION released. Install locally with:"
echo "    rm -rf /Applications/SparkDown.app && cp -R $APP /Applications/"
