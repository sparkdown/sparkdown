#!/bin/bash
# One-time setup of the updater signing key, run by the owner in their OWN
# terminal. Nothing secret is printed: the private key stays in
# ~/.tauri/sparkdown-updater.key (encrypted with your password), the password
# goes to the macOS Keychain and GitHub secrets through pipes only.
#
#   bash scripts/setup-updater-key.sh
#
# Steps:
#   1. Generate the key pair (Tauri asks for a password, twice).
#   2. Store that password in the login Keychain (asked once more, hidden).
#   3. Write the PUBLIC key to src-tauri/updater-pubkey.txt (safe to commit).
#   4. Upload key + password as GitHub Actions secrets (for Linux CI signing).
set -euo pipefail
cd "$(dirname "$0")/.."

KEY="$HOME/.tauri/sparkdown-updater.key"
SERVICE="sparkdown-updater-key"
PUBFILE="src-tauri/updater-pubkey.txt"

if [ ! -x frontend/node_modules/.bin/tauri ]; then
  echo "==> Installing frontend dependencies (needed for the Tauri CLI)"
  (cd frontend && npm ci >/dev/null)
fi
command -v gh >/dev/null || { echo "error: GitHub CLI (gh) not found" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "error: run 'gh auth login' first" >&2; exit 1; }

if [ -e "$KEY" ]; then
  echo "A key already exists at $KEY — not overwriting it." >&2
  echo "Delete it first only if you are sure no release was signed with it." >&2
  exit 1
fi

echo "==> 1/4 Generating the key pair (choose a strong password; you will type it twice)"
mkdir -p "$HOME/.tauri"
chmod 700 "$HOME/.tauri"
# Output goes to YOUR terminal only: the password prompts, the key path and
# the public key (the private key itself is written to the file, not shown).
frontend/node_modules/.bin/tauri signer generate -w "$KEY"
chmod 600 "$KEY" "$KEY.pub"

echo "==> 2/4 Storing the password in the macOS Keychain"
read -rsp "Type the same key password again: " PW </dev/tty
echo
# Check the password against the key by signing a throwaway file, so a typo
# does not end up in the Keychain and in GitHub.
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; unset PW' EXIT
echo check > "$TMP/check"
if ! TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$PW" \
    frontend/node_modules/.bin/tauri signer sign "$TMP/check" >/dev/null 2>&1; then
  echo "error: that password does not unlock the key. Nothing stored; run again." >&2
  rm -f "$KEY" "$KEY.pub"
  exit 1
fi
security delete-generic-password -a "$USER" -s "$SERVICE" >/dev/null 2>&1 || true
# `security` has no stdin option for the secret; -w "$PW" is visible to this
# user's own processes for an instant, and is never printed.
security add-generic-password -a "$USER" -s "$SERVICE" -l "SparkDown updater key password" -w "$PW"

echo "==> 3/4 Writing the public key to $PUBFILE"
cp "$KEY.pub" "$PUBFILE"

echo "==> 4/4 Uploading GitHub Actions secrets"
gh secret set TAURI_SIGNING_PRIVATE_KEY < "$KEY"
printf '%s' "$PW" | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD

cat <<EOF

Done. Nothing secret was printed.
  Private key : $KEY (encrypted with your password, mode 600)
  Password    : macOS Keychain, item "$SERVICE"
  Public key  : $PUBFILE (commit this)
  CI secrets  : TAURI_SIGNING_PRIVATE_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD

Now back up the key: add $KEY and the password to your password manager
(or an encrypted USB stick). If both are lost, installed apps can never
update again.
EOF
