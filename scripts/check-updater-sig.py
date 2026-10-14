#!/usr/bin/env python3
"""Check updater signatures (.sig) against src-tauri/updater-pubkey.txt.

Usage: python3 scripts/check-updater-sig.py FILE.sig [FILE.sig ...]

Each .sig must exist, be a Tauri (minisign) signature, and carry the key ID
of the public key the app ships with; otherwise the app would reject the
update. Used by the package workflows after signing (scripts/release.sh has
the same check inline).
"""
import base64
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def key_id(tauri_b64: str) -> bytes:
    text = base64.b64decode(tauri_b64.strip()).decode()
    line = next(l for l in text.splitlines() if l and not l.endswith(":") and "comment:" not in l)
    return base64.b64decode(line)[2:10]


def main(paths):
    if not paths:
        sys.exit("usage: check-updater-sig.py FILE.sig [...]")
    pub = key_id((ROOT / "src-tauri" / "updater-pubkey.txt").read_text())
    for p in paths:
        sig = pathlib.Path(p)
        if not sig.is_file() or sig.stat().st_size == 0:
            sys.exit(f"error: {p} is missing or empty")
        if key_id(sig.read_text()) != pub:
            sys.exit(f"error: {p} was not signed by the key in src-tauri/updater-pubkey.txt")
        print(f"OK: {p} (key {pub.hex()})")


if __name__ == "__main__":
    main(sys.argv[1:])
