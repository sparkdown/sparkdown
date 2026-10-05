# SparkDown on Omarchy (Linux)

Omarchy is Arch Linux + Hyprland / Wayland. SparkDown is a **Tauri 2 desktop
app**, not a Quickshell rewrite. This page is the Linux install + chrome
notes. The shell plugin that *launches* the app lives in a
separate public repo: https://github.com/paulovitorjp/sparkdown-omarchy

## Chrome (issue #26, closed)

Linux uses a **frameless window with a custom caption**:

- `decorations: false` at runtime on non-macOS (`src-tauri/src/main.rs`)
- App icon in the toolbar opens the native app menu (`show_app_menu`),
  anchored under the icon via window-logical coordinates (not cursor —
  Wayland/GDK often cannot report the pointer, which previously centered
  the menu)
- Min / max / close on the right; no macOS traffic-light padding (`os-linux` class from `frontend/src/titlebar.ts`)
- The title bar holds the document tabs, the Edit | Split | Preview | Diff
  control and the terminal toggle; the activity bar (Files, Changes, Search,
  Remote, Settings) is on the left edge

macOS keeps the overlay title bar and system menu. This was verified in
code; a live Hyprland smoke of the packaged binary is still required on a
real Omarchy machine (CI is headless Ubuntu).

## Keys on Linux

There is no menu bar, so the app handles its shortcuts in JavaScript: the
macOS `⌘` keys in the [README](../README.md#keyboard-shortcuts) are `Ctrl`
here (`Ctrl+P` quick open, `Ctrl+Shift+P` command palette, `Ctrl+1`–`Ctrl+4`
view, `Ctrl+Shift+E` / `G` / `F` sidebar views). The terminal toggle is
`Ctrl+\`` and Terminals Only `Ctrl+Shift+\``. With a terminal pane focused,
splits use `Ctrl+Shift` so the shell keeps plain `Ctrl+D` / `Ctrl+W`:
`Ctrl+Shift+D` split right, `Ctrl+Shift+E` split down, `Ctrl+Shift+W` close
pane, `Ctrl+Shift+]` / `Ctrl+Shift+[` next / previous pane. If a Hyprland
binding takes one of these keys first, the app never sees it.

`Ctrl+Shift+E` is also the Files view key. In a focused terminal it splits
down; anywhere else it opens Files.

## Install the app (no source build)

Produce Linux artifacts with workflow **Linux package**
(`linux-package.yml`: `workflow_dispatch` or a `v*` tag). That job uploads
both a `.deb` and an AppImage. **Install from the `.deb`.** It ships a thin
`usr/bin/sparkdown` that uses system WebKitGTK. The AppImage is a portable
bundle; do not put it on `PATH` as `sparkdown`.

Then:

```
bash scripts/install-linux.sh
```

The script installs into `PREFIX` (default `~/.local`): `bin/sparkdown` and
`share/applications/sparkdown.desktop`. It extracts the ELF from the `.deb`
and refuses to copy an AppImage onto `PATH`.

If this git repo is still private, download the workflow artifact or a
Release `.deb` with `gh` first:

```
gh run download --repo sparkdown/sparkdown --name sparkdown-linux --dir /tmp/sparkdown-dl
PREFIX="$HOME/.local" bash scripts/install-linux.sh /tmp/sparkdown-dl/*.deb
```

On a tagged public Release:

```
gh release download --repo sparkdown/sparkdown --pattern '*.deb' --dir /tmp/sparkdown-dl
PREFIX="$HOME/.local" bash scripts/install-linux.sh /tmp/sparkdown-dl/*.deb
```

Then:

```
sparkdown
```

`sparkdown ~/notes` opens the folder as the workspace root (same routing as
a dropped directory; shipped in #40). The plugin's **Open folder** relies on
this; **Open SparkDown** launches the app with no path.

### AUR (`sparkdown-bin`)

A PKGBUILD is in `packaging/aur/sparkdown-bin/`. It is **not published to
the AUR yet**: GitHub Releases must be publicly downloadable first (this
application repo was private when this was written). After the first public Linux
asset, `makepkg -si` from that directory.

Do not `omarchy pkg add` SparkDown into core Omarchy — that is a later ask
once there are users.

## Install the shell plugin

```
omarchy plugin add https://github.com/paulovitorjp/sparkdown-omarchy.git --enable
```

The plugin only launches SparkDown (`menu` + `bar-widget`). It does not
embed the editor.

## Smoke checklist (real Omarchy machine)

1. Install via `scripts/install-linux.sh` from the `.deb`, or the
   `sparkdown-bin` PKGBUILD — not `cargo build`, not the AppImage on PATH.
2. `sparkdown` opens a frameless window; toolbar is not inset for traffic lights.
3. Click the top-left app icon: the native menu opens under/near that icon
   (top-left), not centered in the window.
4. Plugin Open folder / `sparkdown ~/some/folder` sets the sidebar root.
5. `omarchy plugin add https://github.com/paulovitorjp/sparkdown-omarchy.git --enable`
6. Bar button: Open SparkDown actually starts the app.

## Out of scope here

Windows as a launch platform, embedding the editor in Quickshell,
`omarchy pkg add` into core Omarchy, share-a-link, libghostty.
