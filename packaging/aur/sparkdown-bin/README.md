# sparkdown-bin (AUR)

Binary package for Arch / Omarchy. **Not submitted to the AUR yet.**

It repackages the thin `.deb` release asset (system WebKitGTK) and installs the
ELF it carries as `/usr/bin/sparkdown`. It deliberately does **not** use the
AppImage: the AppImage is a portable bundle and must never land on `PATH` as
`sparkdown` (see the repo README and `scripts/install-linux.sh`).

After the first public `v*` Linux Release on `sparkdown/sparkdown`:

1. Make sure `pkgver` and the `.deb` `sha256sums` entry match the release:
   ```
   bash scripts/update-pkgbuild.sh <version>
   ```
   (`scripts/release.sh` runs this for you at release time.) The two static
   files here — `sparkdown.desktop` and `sparkdown.png` — keep their own
   checksums and only change if you edit them.
2. `makepkg -si` from this directory, then publish to the AUR.

`sparkdown.png` is a copy of `src-tauri/icons/128x128.png`; refresh it if the
app icon changes.

Until the repo is public, use `scripts/install-linux.sh` against a workflow
artifact or `gh release download`.
