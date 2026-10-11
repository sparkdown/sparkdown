# SparkDown

[![CI](https://github.com/sparkdown/sparkdown/actions/workflows/ci.yml/badge.svg)](https://github.com/sparkdown/sparkdown/actions/workflows/ci.yml)

A small markdown editor for you and your coding agents.

Open the folder an agent works in, run the agent in the built-in terminal, and review what it changes: files update live, and the Changes view is a review queue with a diff that hides the noise. Built with [Tauri 2](https://tauri.app/) (Rust backend, the OS webview, no Electron). The macOS app is 4.2 MB installed (3 MB DMG), for Apple Silicon.

SparkDown is local-first and works with any agent CLI. It never hosts your files and never calls a vendor API: it watches the filesystem and runs `git`. No account, no telemetry: the only request it makes on its own is an update check on GitHub, at most once a day, with no identifier (see [Updates](#updates) to turn it off).

## Features

**Workspace**

- **Activity bar** on the left: Files, Changes, Search in files, plus Remote and Settings. Click a view to open the sidebar on it; click the active view again to close the sidebar.
- **Files**: the folder tree. The active file is highlighted and revealed on tab switch, other open files get a dot, and git status shows as M/A/D/R/U letters. Filter, show hidden files, collapse all, drag files out to other apps.
- **Search in files**: plain text search (not regex, not case-sensitive) over the open folder, grouped by file. Click a result to open the file at that line.
- **Quick open** (`⌘P`): fuzzy file search over the folder, recent files first. Type `>` for commands or `:` to go to a line. `⌘⇧P` opens the **command palette** directly; every action is in it.
- **Open Folder** from the welcome screen, by drag-and-drop, or with `sparkdown ~/folder` from the CLI.

**Editor and preview**

- CodeMirror 6 editor with a live markdown preview: code highlighting, Mermaid diagrams, GFM tables, task lists, local images, table of contents, export to standalone HTML.
- One **view per tab**, set in the title bar: **Edit | Split | Preview | Diff** (`⌘1`–`⌘4`). Views a file can't show are disabled (no preview for a `.rs` file, no diff without git changes).
- `.html` / `.svg` preview in a sandboxed iframe. JavaScript is off by default; you can turn it on per file, for the current session.
- Tabs with an unsaved-changes guard; light and dark themes that follow the OS.

**Agent cockpit**

- **Terminals** (xterm.js on a real PTY) in a drawer: `⌃\``. Split a pane right or down, up to 4 panes, and drag the dividers. With tmux installed, each pane is its own tmux session and the layout comes back after a restart. **Terminals Only** (`⌃⇧\``) fills the center column with the terminals. Pane headers have launch buttons for the agent CLIs SparkDown finds.
- **Live file watching**: the tree, editor and preview follow what the agent writes; changed files flash in the tree.
- **Changes** is a review queue for the git working tree: "3 / 7 reviewed", a progress bar and a checkbox per file. **Worth reading** comes first; lockfiles, generated and vendored files fold into a collapsed **Probably noise** group. `↑`/`↓` move, `Space` toggles reviewed (marking a file moves to the next one), `Enter` opens the diff. A reviewed file is pending again when it changes again.
- **Reading diff**: import-only and whitespace-only hunks fold away (Reading ⇄ Full). The diff header has previous / next file and **Mark reviewed**; each hunk links to its line in the editor.
- **MCP server**: agents in SparkDown terminals find SparkDown over MCP; you type no prompt. Read tools show what you are viewing (active file, the exact text of open buffers, exact lines by number, the cursor line's text, selection, git changes, reading diffs). One write tool edits the *unsaved* editor buffer, for you to review and save. It uses a per-user Unix socket / Windows named pipe (no port, no token) and answers only inside SparkDown terminals. For agents that need an install, the first launch from a chip asks **"Give <Agent> SparkDown's tools?"**: **Install** adds SparkDown once to that agent's own config (other entries kept), **Not now** launches with the reading prompt, and **Don't ask again** stops asking for that agent. Settings → Agents installs or removes it for each detected agent, turns the prompt back on ("Ask again when launching"), or turns sharing off. How each agent gets the tools:

  | Agent | How it gets SparkDown's tools |
  | --- | --- |
  | Claude Code, Codex, opencode | Per launched session (`--mcp-config`, `-c`, `OPENCODE_CONFIG_CONTENT`); nothing is written |
  | Gemini CLI, Kiro, Grok | Install runs the agent's own `mcp add` |
  | Cursor CLI, Antigravity (`agy`) | Install writes one `"sparkdown"` entry to `~/.cursor/mcp.json` / `~/.gemini/config/mcp_config.json` |
  | Any other agent CLI | The file-bridge reading prompt (`$SPARKDOWN_CONTEXT`) |
- **Agent context bridge**: the older, file-based channel. Agents read what you are viewing from `$SPARKDOWN_CONTEXT` (an owner-only folder, written only while a terminal is open, removed on quit). Same off switch in Settings → Agents.
- **Remote folders over SSH**: File → Open Remote Folder (`⌘⇧O` / `Ctrl+Alt+O`) picks a host from `~/.ssh/config` or takes a typed `user@host[:port]`. The editor, Files, Changes, Search, the watcher and the terminals all run on the host through your existing SSH keys (no passwords, no cloud). Open and Save As use an in-app file picker that browses the host. First connects show the host's key fingerprints for you to confirm; see [docs/remote-ssh.md](docs/remote-ssh.md).

**Status bar**

- Left: the file path (click to copy it) and an unsaved dot, the git branch with ahead/behind (`main ↑1 ↓2`), the remote host chip (click to disconnect or switch hosts), the agent tools (MCP) state, and the update notice when an update is ready.
- Right: words, characters, lines, `Ln, Col` (click to go to a line) and `Wrap` (click to toggle).

**Platform**

| Platform | Status | Get it |
|---|---|---|
| macOS (Apple Silicon) | Supported | DMG from [Releases](https://github.com/sparkdown/sparkdown/releases), or `scripts/package-macos.sh` |
| Linux (x64) | Supported | `.deb` / AppImage, see [docs/omarchy.md](docs/omarchy.md) |
| Windows 10/11 (x64) | Preview | Build from source (`scripts\package-windows.ps1`) or the CI artifact, see [docs/windows.md](docs/windows.md) |

- macOS: frameless window with native traffic lights, Open With, CLI file arguments.
- Linux: frameless window with a custom caption (Hyprland / Wayland tested), a `.deb` (thin binary, system WebKitGTK) and an AppImage (a portable bundle: do not put it on PATH as `sparkdown`). Omarchy plugin.

## Keyboard shortcuts

On Windows and Linux, `⌘` is `Ctrl` and `⌥` is `Alt`. Help → Keyboard Shortcuts (`⌘⇧H`) shows the list in the app.

| Action | Keys |
| --- | --- |
| New file / new tab | `⌘N` / `⌘T` |
| Open file / folder / remote folder | `⌘O` / `⌘⌥O` / `⌘⇧O` |
| Save / Save As | `⌘S` / `⌘⇧S` |
| Close tab | `⌘W` |
| Find / go to line | `⌘F` / `⌘⌥G` |
| Bold / italic | `⌘B` / `⌘I` |
| Quick open / command palette | `⌘P` / `⌘⇧P` |
| Edit / Split / Preview / Diff | `⌘1` / `⌘2` / `⌘3` / `⌘4` |
| Files / Changes / Search in files | `⌘⇧E` / `⌘⇧G` / `⌘⇧F` |
| Toggle sidebar | `⌘⇧B` |
| Toggle terminal / Terminals Only | `⌃\`` / `⌃⇧\`` (Ctrl on every platform) |
| Toggle word wrap | `⌘⇧W` |
| Next / previous tab | `⌘⌥→` / `⌘⌥←` |
| Settings / keyboard shortcuts | `⌘,` / `⌘⇧H` |

When a terminal pane has focus (elsewhere, the editor keeps `⌘D` and `⌘[` / `⌘]`):

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Split right | `⌘D` | `Ctrl+Shift+D` |
| Split down | `⌘⇧D` | `Ctrl+Shift+E` (in a focused terminal) |
| Close pane | `⌘W` | `Ctrl+Shift+W` |
| Next / previous pane | `⌘]` / `⌘[` | `Ctrl+Shift+]` / `Ctrl+Shift+[` |

In the Changes list: `↑`/`↓` (or `j`/`k`) move, `Space` toggles reviewed, `Enter` opens the diff, `⇧Enter` opens the file in the editor.

## Install

**macOS** (Apple Silicon, macOS 10.15+): download the DMG from [Releases](https://github.com/sparkdown/sparkdown/releases). On first launch, right-click the app → **Open** to clear Gatekeeper (the build is not notarized yet).

**Linux / Omarchy**: see [docs/omarchy.md](docs/omarchy.md). In short, install from the `.deb`, not the AppImage:

```bash
gh release download --repo sparkdown/sparkdown --pattern '*.deb' --dir /tmp/sparkdown-dl
PREFIX="$HOME/.local" bash scripts/install-linux.sh /tmp/sparkdown-dl/*.deb
sparkdown ~/some/folder
```

To install a CI build instead, download the workflow artifact: `gh run download --repo sparkdown/sparkdown --name sparkdown-linux --dir /tmp/sparkdown-dl`. `scripts/install-linux.sh` extracts `usr/bin/sparkdown` from the `.deb` and refuses to copy an AppImage onto PATH.

Omarchy shell plugin (it launches the app; it does not embed the editor):

```bash
omarchy plugin add https://github.com/paulovitorjp/sparkdown-omarchy.git --enable
```

An AUR `sparkdown-bin` PKGBUILD is in `packaging/aur/sparkdown-bin/` (not submitted yet).

**Windows** (preview, Windows 10/11 x64): see [docs/windows.md](docs/windows.md). Download the `sparkdown-windows` artifact of the **Windows package** workflow, or build the installer yourself with `scripts\package-windows.ps1`. The installer is per user (no admin) and not code-signed yet: SmartScreen asks you to click **More info → Run anyway**.

## Updates

- **macOS app and Linux AppImage** update themselves. Shortly after launch (at most once a day) SparkDown checks GitHub Releases. If there is a new version, the status bar shows **Install & Restart** or **Later**. Install downloads the update, verifies its signature, asks about unsaved changes (Cancel keeps the app running), and relaunches.
- **`.deb`, AUR and other package installs** only show that an update exists. Update with your package manager, or install the new `.deb`.
- **If SparkDown can't write to its own folder** (for example a root-owned `/Applications`, or the app runs from the DMG), and on Windows, the notice offers **Download**, which opens the release page.
- **Check now**: SparkDown → Check for Updates... (macOS), or Help → Check for Updates... (Linux/Windows).
- **Turn off the daily check**: Settings → Updates → *Check for updates automatically*.

Updates are signed; the app rejects an update that its built-in public key does not verify (see [SECURITY.md](SECURITY.md#auto-update)). The updater adds no network library: it uses the system `curl`. The check needs public Releases; if the manifest URL is unreachable the check fails quietly and nothing changes.

## Build from source

Prerequisites: [Rust](https://www.rust-lang.org/tools/install) (stable) with the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform, and [Node.js](https://nodejs.org/) 22+.

```bash
cd frontend
npm install
npm run tauri dev      # development, hot-reloads the frontend
npm run tauri build    # release bundle → src-tauri/target/release/bundle/
```

macOS package with file associations: `bash scripts/package-macos.sh`, then copy `SparkDown.app` to `/Applications`.
Linux `.deb` + AppImage: the **Linux package** GitHub Actions workflow (manual dispatch or a `v*` tag).
Windows NSIS installer (preview): `powershell -ExecutionPolicy Bypass -File scripts\package-windows.ps1` on a Windows PC (it checks the prerequisites first; see [docs/windows.md](docs/windows.md)), or the **Windows package** workflow (manual dispatch or a `v*` tag).
Releases: `bash scripts/release.sh <version>` (maintainer only; see the header of that script).

## Test

```bash
cd frontend && npx tsc --noEmit && npm test && npm run build
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

CI runs the same on every push and pull request, plus `cargo audit` and `npm audit`. Frontend integration tests boot the real app with the Tauri IPC boundary mocked (`frontend/src/__tests__/helpers/`).

## Architecture

```
frontend/                   # TypeScript UI, bundled by Vite
  index.html                # App shell: title bar, activity bar, sidebar, panes, status bar
  src/
    main.ts                 # Entry point: boots the App, installs remote sessions
    app.ts                  # Orchestration: builds the controllers below and wires the event bus
    app/                    # Controllers the App owns
      actions.ts            #   Menu / shortcut / palette actions → handlers (⌘W closes a focused terminal pane)
      builtin-commands.ts   #   The app's own command palette entries
      context.ts            #   Shared state the controllers read
      documents.ts          #   Open / save / save as / export, unsaved-changes prompts
      workspace.ts          #   Open folder, recent folders, watcher → tree / tabs
      view-mode.ts          #   Per-tab Edit | Split | Preview | Diff
      panes.ts              #   Editor / preview split, scroll sync
      diff.ts               #   Changes queue, diff pane, branch status
      cockpit.ts            #   Terminal drawer and Terminals Only layout
      agent-context.ts      #   Publishes editor state to the MCP server and $SPARKDOWN_CONTEXT
      html-scripts.ts       #   Per-file "allow JavaScript" for HTML/SVG preview
      welcome.ts, lifecycle.ts, layout.ts, export-html.ts
    editor.ts               # CodeMirror 6 editor
    preview.ts              # marked + highlight.js + DOMPurify render, sandboxed HTML preview
    preview-images.ts, preview-search.ts, mermaid-loader.ts, toc.ts
    tabs.ts                 # Tab model and title bar tab strip
    view-mode.ts            # Which views a file can show; view-control.ts is the title bar control
    activity-bar.ts         # Files / Changes / Search, Remote, Settings
    file-tree.ts            # Files view: git letters, open-file dots, watcher flash, drag-out
    changes-view.ts         # Changes review queue + unified-diff renderer (Reading / Full)
    review-state.ts         # Reviewed marks, keyed by path + change fingerprint
    meat.ts                 # Noise heuristics: lockfiles, generated files, import/whitespace-only hunks
    search-view.ts          # Search in files view; search-panel.ts is the in-editor find widget
    palette.ts              # Quick open / command palette overlay; fuzzy.ts scores matches
    commands.ts             # Command registry the palette reads
    shortcuts.ts            # KEYBINDINGS table, keydown handling, terminal pane keys
    shortcuts-dialog.ts     # Help → Keyboard Shortcuts
    terminal.ts             # xterm.js panes, agent launch buttons
    split-layout.ts         # Terminal split tree (pure functions, max 4 panes)
    remote.ts               # Open Remote Folder dialog, remote status chip
    remote-picker.ts        # In-app file picker for the SSH host
    updater.ts              # Update check and status bar notice
    statusbar.ts, titlebar.ts, toolbar.ts, settings-dialog.ts, theme.ts
    workspace-layout.ts     # Sidebar / terminal drawer / Terminals Only state
    modal.ts, context-menu.ts, resize-drag.ts, crash-log.ts, perf-trace.ts
    events.ts, event-names.ts, api.ts, utils.ts, constants.ts, file-types.ts
    types/                  # AppConfig.ts etc., generated from Rust via ts-rs
    styles/                 # CSS

src-tauri/                  # Rust backend (Tauri)
  src/
    main.rs                 # App setup, plugins, command registration, quit, htmlpreview:// protocol, navigation guard
    commands.rs             # read_file / write_file / list_directory / config / clipboard; path validation
    fsio.rs                 # Crash-safe (atomic) file writes
    config.rs               # AppConfig persistence (+ ts-rs export under test)
    menu.rs                 # Native application menu and accelerators
    terminal.rs             # PTY terminals (portable-pty), tmux sessions
    watcher.rs              # Filesystem watcher (notify) → watcher://changes events
    git.rs                  # git status / diff / branch via the user's git
    review.rs               # Changes queue: +/− counts, change fingerprints, reviewed marks file
    search.rs               # Search in files (local walk, or find + grep over SSH)
    file_index.rs           # Workspace file list for quick open (cached)
    meat.rs                 # Reading-diff heuristics (Rust port of meat.ts, used by MCP)
    context.rs              # Agent context bridge ($SPARKDOWN_CONTEXT), agent CLI detection
    mcp.rs / mcp_stdio.rs   # In-app MCP server (Unix socket / named pipe) + the stdio shim agents run
    updates.rs              # Auto-update: system curl + minisign verification + install swap
    remote/                 # SSH sessions (multiplexed ssh: files, git, watcher, PTY) + mcp_shim.sh
    macos_quit.rs           # Dock-quit interception on macOS
  capabilities/default.json # Tauri permission grants
  tauri.conf.json           # Window, bundle, CSP, file associations
  updater-pubkey.txt        # Updater public key (compiled in)

scripts/                    # install-linux.sh, package-macos.sh, package-windows.ps1, release.sh, setup-updater-key.sh, update-pkgbuild.sh
packaging/                  # Linux .desktop file, AUR PKGBUILD
docs/                       # Platform notes + release notes
website/                    # Landing page (static HTML)
```

`frontend/src/types/` is generated from the Rust structs by [`ts-rs`](https://github.com/Aleph-Alpha/ts-rs) when `cargo test` runs in `src-tauri/`. Edit the Rust side.

Platform notes: [docs/omarchy.md](docs/omarchy.md) (Linux), [docs/windows.md](docs/windows.md) (Windows preview). Release notes drafts used by `scripts/release.sh` live under `docs/release-notes-*.md`.

## Size comparison

| App | macOS bundle |
| --- | --- |
| SparkDown | 4.2 MB |
| Typora | ~80 MB |
| VS Code | ~300 MB |

Tauri apps stay small because they use the operating system's webview instead of bundling Chromium.

## Security and privacy

See [SECURITY.md](SECURITY.md). In short: the preview runs untrusted documents in a sandboxed iframe with scripts off by default; remote sessions use only your existing SSH keys; the MCP server listens only on a per-user socket; the agent context bridge writes to an owner-only temp folder, only while a terminal is open, and can be turned off. There is no telemetry. The update check (at most once a day) is one HTTPS request to GitHub Releases that sends only a `SparkDown/<version>` user agent; turn it off in Settings → Updates.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and the PR checklist, and [CHANGELOG.md](CHANGELOG.md) for what changed in each release. Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE)
