# Changelog

All notable user-visible changes to SparkDown. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Numbers in parentheses are pull
requests.

## Unreleased (0.4.3)
- Terminal: Quote the agent server path in the Claude launch line.
- Files: Check that the opened file is a regular file and cap the read.
- Preview: Bind HTML script execution to the confirmed document.
- Preview: Key Mermaid diagram and fenced-code caches on exact source text.
- Preview: Restrict preview images to the workspace folder.
- Markdown: Include reference-link definitions in chunk cache key.
- Diff: Show Unicode bidirectional and invisible control characters.
- Preview: Optimize preview search match filtering.
- Search: Bound fuzzy-path matching steps.
- Markdown: Cache reference-link definition parsing.
- Read-only git operations no longer trigger hooks from the repository.
- Git diff operations now timeout after 20 seconds and reject special file types.
- Filter and diff driver enumeration now covers included config and worktree scope.
- Filter and diff driver config is applied via environment variables to handle names containing special characters.
- Remote git operations over SSH apply filter and diff driver neutralization.
- Read-only git operations block partial clone lazy fetches and protocol execution.
- Background fetch is skipped for repositories whose config sets commands.
- Remote: Delete and create operations verify paths resolve inside the window's folder on the host.
- Remote: Agent CLI watchdog creates timeout marker directory with exclusive permissions.
- SSH: Host-key trust flow checks all known_hosts files before scanning.
- SSH: Passphrase broker uses per-connection nonces and verifies peer credentials.
- MCP: sparkdown_forward is restricted to the core local socket and needs a per-launch nonce; each window's forwarded socket needs a per-window token.
- Remote MCP on SSH hosts requires Python 3 on the remote host. Terminals opened before an app restart need to be reopened for MCP to work.
- Files: Saving over an existing file stages the new contents in an owner-only temporary file until the data is written.

### Changed

- **MCP socket folder location** (Unix): on Linux without `XDG_RUNTIME_DIR` set, the socket moves from `/tmp/sparkdown/mcp.sock` to `~/.cache/sparkdown/mcp.sock`. The folder is created with mode 0700 and verified to be owned by your user and not a symlink before binding or connecting. macOS is unchanged (still the per-user `$TMPDIR/sparkdown`), and Linux with `XDG_RUNTIME_DIR` set is unchanged. Terminal sessions started before the upgrade will need to be restarted to reconnect to the new socket location.

## [0.4.2] — 2026-11-09

Terminal, Git and command-line improvements on top of 0.4.1. Not in this
release: the Hyprland work (#186), the WSL agent tools (#187) and the
terminal performance work (#219); they wait for testing on real machines.

### New

- **Find in the terminal:** `Ctrl+Shift+F` on Windows and Linux (plain `Ctrl+F` stays with the shell), `⌘F` or Edit > Find on macOS when a terminal has focus. Each pane has its own find bar with a match count (“2 of 5”, “No results”). `Enter` / `F3` go to the next match, `Shift+Enter` to the previous one, `Esc` closes the bar and returns to the terminal. Keys typed in the bar never reach the shell. (#184)
- **Safer terminal links:** web links open only with `Ctrl`+click (`⌘`+click on macOS), and only `http` / `https` links with a host; a plain click no longer launches the browser. File paths still open with a plain click. Links that wrap onto the next row are recognised. (#184)
- **Terminal scrollback setting:** Settings → Scrollback lines takes any whole number from 200 to 50,000 (default 5,000; values outside the range are clamped). The change is saved right away and applies to open and new terminals. (#184)
- **Mouse wheel in tmux terminals** scrolls tmux's history instead of sending Up/Down to the shell, which used to recall old commands. Scrolling back to the bottom, or typing, leaves the history view. Full-screen apps inside tmux still get Up/Down. (#184)
- **`sparkdown` command on your PATH:** the Windows installer adds it (skip with `/SDNOPATH`) and the uninstaller removes it; on macOS, and for the Linux AppImage, the SparkDown menu has Install / Uninstall / Repair 'sparkdown' Command in PATH. The `.deb` and AUR packages already ship `/usr/bin/sparkdown`. Run from a terminal, `sparkdown` gives the prompt back unless you pass `--wait`, and `--` ends the options so a path starting with `-` can be opened. (#188)
- **Pull when branches have diverged:** if you have not set `pull.rebase` or `pull.ff`, Pull merges the remote changes instead of failing; your own git settings still win. Merge and rebase conflicts are reported with the files involved and are never aborted for you. (#218)
- **Background fetch:** while a window is focused, SparkDown quietly fetches the current branch's upstream (on focus, every 5 minutes, and after a rejected push) so the Pull count shows new commits. It only fetches, never merges, never asks for credentials, and is off in remote (SSH) folders. Turn it off in Settings → Git → Fetch in the background. (#218)
- **Discard changes** in the Changes view: a per-file Discard button, Discard Changes… in the right-click menu, **Discard All** in the Changes header, and `Shift+F10` / the Menu key on the selected file. A confirmation lists each file and what will happen to it: edits are reverted to the last commit, and new files are moved to the system Trash (the Recycle Bin on Windows), never deleted outright. A file that changed while the confirmation was open is left alone and reported. Open tabs with unsaved edits keep them unless you tick the box to drop them. Not available in remote (SSH) folders. (#218)

### Fixed

- **Status bar edges:** the first and last items no longer sit against the window border (8 px inset, 12 px on macOS for the rounded corners). (#178, #179)

### Security

- tokio 1.51.6, for [RUSTSEC-2026-0386](https://rustsec.org/advisories/RUSTSEC-2026-0386). (#157)
- minisign-verify 0.3.0, the library that checks update signatures, which removes some `unsafe` code. (#4) minisign 0.10.0 is used only by the tests that sign fake updates. (#5)

## [0.4.1] — 2026-11-05

Fixes and small features on top of 0.4.0.

### New

- **File > Close Folder** returns the window to the empty state. (#127, #138)
- **Commit, Pull and Push** in the Changes view. (#122, #139) Since #146 they are icons in the Changes header (Commit ✓, Pull ↓ with the behind count, Push ↑ with the ahead count, next to Refresh), and Commit opens a compact panel: message (⌘/Ctrl+Enter commits, Esc closes), files with checkboxes and select-all, and a Commit button. Progress and results show in the status bar (a spinner with Committing… / Pulling… / Pushing…, then a short message such as “Pushed 2 commits to origin/main” that fades; errors stay in a warning colour until clicked), and a new **Git** tab in the bottom pane keeps the full output of every commit, pull and push in that window. Clicking the status message opens it. (#148)
- **Explorer: Delete…** asks for confirmation and moves the item to the trash. (#121, #134)
- **File > New Window** shows its shortcut and sits next to Open Folder. (#128, #133)
- **Explorer right-click menu by context:** New File, New Folder, Delete…, Reveal in Finder / File Explorer / File Manager and Copy Path on files and folders (New File / New Folder create inside a folder, with the name typed inline in the tree); New File and New Folder on empty space. The webview's own menu (Reload, Inspect…) no longer appears; text fields and the editor keep Cut / Copy / Paste. (#145)

### Fixed

- **Commit button contrast:** the enabled Commit button's label now meets WCAG AA in light and dark themes, and the disabled button is an outline, so the two states look clearly different. (#148)
- **Save dialog for a new file** starts in the folder selected in the explorer, or the opened folder, instead of its parent. (#144)
- **About** dialog works on Linux and Windows. (#120, #132)
- **Linux terminal paste/copy:** `Ctrl+V` and `Shift+Insert` paste, and `Ctrl+C` copies when text is selected (fixes Omarchy `Super+V`). (#130, #135)
- **Windows restore at exactly their saved size and position**, with no size creep on restart. (#112, #136)
- **`Ctrl+Q` quits from a focused terminal** on Windows and Linux, with the usual prompt when there are unsaved edits or running jobs. (#140)

### Removed

- Unused early source art and its README mention. (#126, #131)

## [0.4.0] — Unreleased

One window per folder: several projects side by side in one app, each window
with its own files, Changes, search, terminals, remote session and agents.
Includes the 0.3.2 fixes. Release notes: [docs/release-notes-0.4.0.md](docs/release-notes-0.4.0.md).

### New

- **Multiple windows, one per folder.** Opening a folder that is already open focuses its window; an empty window is reused; otherwise a new window opens. (#78, #79, #80)
- **New Window** (`Ctrl+Shift+N` / `⌘⇧N`), a **Window menu** listing every window, and window titles that show the folder (plus host for remote folders). (#81)
- **Open in New Window**: `Ctrl`/`⌘`-click a recent folder, the "Open in new window" checkbox in Open Remote, the palette command, or `sparkdown --new-window <folder>`. A folder that is already open just focuses its window. (#84)
- **Recent folders show where they are open** ("● open in window N") on the welcome screen and in new "Open recent" palette commands. (#84)
- **Restart restores every window** with its folder, open files and terminal layout. Window positions are restored on macOS, Windows and X11; on Wayland only sizes. (#79)
- **Agents follow their window.** Each window's terminals carry a routing token that is stable per folder, so an agent reaches its own window even after `cd` or a tmux reattach. New `sparkdown_list_windows` tool. (#82, #83)
- **External agents** (not started in a SparkDown terminal) are off by default, behind Settings → Agents → External agents. When on, they must name a folder (`--folder` or `SPARKDOWN_FOLDER`) or get the focused window if only one is open. (#82)
- **One quit prompt** lists the running terminals in every window and the windows with unsaved changes. (#81, #85)
- `sparkdown <path>` in a terminal hands the path to the running app, which opens it in the right window. (#57)

### Fixed

- Windows: helper processes no longer flash a console window. (#18)
- Windows/Linux shortcuts and labels, and Terminals Only in the menus. (#19)
- Windows installer: upgrading over a pre-0.3.1 install uninstalls it first. (#20)
- Remote: typed `user@host[:port]`, a themed host list, a first-connect host-key check, an in-app SSH key passphrase prompt, and a clear message when the server rejects your keys. (#26, #38, #39, #56)
- Remote: saved edits reach Changes, and the tree shows every row when it was built while hidden. (#34, #35)
- Terminal: `Ctrl+W` stays with the shell on Windows/Linux; `Ctrl+W`/`Super+W` close the pane where that applies, and closing a busy pane asks first, judged by the foreground process group (also in tmux). (#40, #44, #54)
- Agent tools: `--mcp-stdio` exits when its parent dies; configs pointing at a missing SparkDown are detected and repaired; installs are non-interactive with a 20 s timeout and show the real error. (#37, #41, #55)
- `sparkdown --version` and `--help` print and exit without opening a window. (#36)
- Changes shows an untracked nested repository as a folder and never opens a directory as a tab. (#53)
- Cosmetics: `Alt+Z` wrap, shortcut list overflow, port-aware keygen hint, askpass retry, remote tab titles. (#58)
- macOS: `⌥Z` toggles word wrap by key code. (#59)
- A shell is found when `$SHELL` is unset (zsh, then bash, then sh). (#85)

### Notes

- Linux binary is about 0.7 MB larger (+11.6%), from the D-Bus stack of the single-instance plugin (#57).

## [0.3.1] — 2026-10-04

A new layout built around reviewing what your agent changed, signed
auto-updates, and a long list of data-safety and security fixes.

### New

- **Activity bar** on the left: Files, Changes, Search in files, Remote and Settings. (#144)
- **Files-only tree**: the active file is revealed on tab switch, other open files get a dot, folders show a dot when something inside changed. (#144)
- **Search in files**: plain-text search over the open folder, local or remote; click a result to open that line. (#144)
- **Quick open** (`⌘P`) with recent files first, and a **command palette** (`⌘⇧P`) that lists every action. (#145)
- **Per-document view**: each tab has its own Edit | Split | Preview | Diff (`⌘1`–`⌘4`). (#146)
- **Cleaner title bar**: just tabs, the view control and the terminal toggle; the rest moved to the menus and palette. (#146)
- **Status bar**: file path, git branch with ahead/behind, remote host chip, agent tools (MCP) state, and a character count. (#100, #146)
- **Terminal splits**: split right or down (up to 4 panes), drag the dividers; with tmux the layout comes back after a restart. (#143)
- **Terminals Only** layout (`` ⌃⇧` ``) hides the editor so the terminals fill the window. (#108)
- **Changes review queue**: "3 / 7 reviewed", a progress meter, a checkbox and +/− counts per file; `↑`/`↓` move, `Space` marks reviewed. (#148, #149)
- A reviewed file that changes again goes back to pending with a "changed again" dot. (#148, #159)
- **Remote file picker**: Open, Save As and Export HTML browse the SSH host while you work remotely, and can create folders. (#129, #139)
- **Signed auto-updates** for the macOS app and the Linux AppImage, with a download progress bar; `.deb` and AUR installs only show that an update exists. (#130, #140)
- **Open Folder** and **Open Remote Folder** side by side in the File menu, with `⌘⌥O` for Open Folder. (#102, #104)
- A centered "pick a file" prompt when a folder is open but no file is. (#147)
- **opencode** replaces Aider in the agent chips and Settings → Agents. Like Claude Code and Codex, it gets SparkDown's tools for the launched session only (`OPENCODE_CONFIG_CONTENT`, merged with your own config; nothing is written). (#163)
- **Agent tools at launch**: launching Gemini, Grok, Kiro or Cursor from a chip asks once whether to install SparkDown's MCP tools into that agent (Install / Not now / Don't ask again); Settings → Agents can ask again. **Cursor CLI** can now be installed too: SparkDown adds one entry to `~/.cursor/mcp.json` and keeps the rest. (#161)
- **Antigravity CLI** (`agy`) in the agent chips and Settings → Agents. Install adds one entry to `~/.gemini/config/mcp_config.json` and keeps the rest, the same way as Cursor. (#163)
- **Windows build script and installer (preview)**: `scripts\package-windows.ps1` checks the prerequisites and builds a per-user NSIS installer (no admin); the **Windows package** workflow builds it in CI. See [docs/windows.md](docs/windows.md). (#167)

### Improved

- Rounded panels, and you drag the gap between them to resize. (#99)
- Diagrams load only when a document has one, so the app starts faster. (#128)
- Remote sessions no longer freeze the window on a slow or dropped connection, and work with fish/csh login shells. (#121, #124)
- The reading diff no longer hides reordered lines as "formatting", and catches spacing changes inside a line. (#157)
- Reload from disk keeps your cursor, scroll position and undo history. (#123)
- An open diff updates when the file changes on disk. (#123)
- Double-clicking the macOS title bar zooms the window. (#94)

### Fixed

- **Remote saves** check the written size before replacing the file, and keep a backup when they must copy in place, so a dropped connection can no longer leave a partial file. (#132, #141)
- **Atomic saves**: local and remote saves write a temp file and rename it, and never break symlinks. (#110)
- Remote reads no longer corrupt files that are not UTF-8. (#110)
- **Disk-change conflicts**: if a file changes on disk while you have unsaved edits, the tab is marked, and Save asks Overwrite / Reload / Cancel. (#109)
- `Ctrl+Q` on Windows and Linux now asks about unsaved changes instead of quitting. (#109)
- Tabs remember which machine they came from, so a file is never saved to the wrong machine after you connect or disconnect. (#111, #133)
- Keys typed in Diff or Preview view no longer edit the hidden document. (#159)
- **Symlinked folders**: git changes, tree badges and the watcher now match open tabs when a folder is opened through a symlink. (#152, #155)
- **tmux**: SparkDown sessions hide the tmux status line, and terminals get the right workspace environment. (#117, #152, #154)
- A terminal tab closes when its shell exits on Linux and Windows. (#96)
- **Windows: agent chips start the agent.** The chip runs it in PowerShell (7 or 5.1) and the shell stays open after it; agents installed as `.exe`, npm `.cmd` / `.ps1` shims or Store aliases get a chip; Claude Code, Codex and opencode get SparkDown's tools without inline JSON on the command line; `mcp add` installs run without a shell. Remote folders keep POSIX syntax. See [docs/windows.md](docs/windows.md).
- The file watcher no longer hangs when a new folder is created. (#115)
- The remote tree no longer jumps to the top on every refresh, and recent remote folders reopen. (#101, #103)
- Preview images load for files opened on their own and for remote files. (#134)
- `⌘I` italicizes just the word; `⌘⇧G` opens Changes even in the editor. (#116, #156)
- Mermaid diagrams follow a theme change. (#116)
- `Ctrl+Shift+E` splits a focused terminal on Windows and Linux. (#153)
- The Linux/Windows app menu opens under the app icon. (#95)
- The macOS app opens every supported file type and no longer shows as "damaged" after download. (#135)
- **Agent line numbers**: `sparkdown_get_lines` gives exact lines by number (the numbers the editor shows), and the context gives the cursor line's text, so an agent asked about "line 7" no longer counts lines itself and answers with the wrong one. `sparkdown_read_buffer` stays the exact raw text. (#163, #164)
- **Codex** now gets SparkDown's tools: Codex starts MCP servers with a filtered environment, so the launch command forwards `SPARKDOWN_MCP` to it (`-c mcp_servers.sparkdown.env_vars`), also when SparkDown is installed in Codex and on remote hosts. (#163)
- The Cursor entry SparkDown installs now passes `SPARKDOWN_MCP` explicitly (`${env:SPARKDOWN_MCP}`), so Cursor cannot hit the same problem. To update an entry installed before, remove it and install it again in Settings → Agents. (#163)

### Security

- Opening an untrusted repository no longer runs its git filter or diff drivers when SparkDown shows changes. (#120)
- Links in the preview can no longer navigate the app window; web links open in your browser. (#112)
- The preview can load images only from folders and files you opened, and the app's content policy no longer allows `eval`. (#118, #134)
- The agent context folder refuses planted symlinks and folders owned by other users; on Windows the MCP pipe has an unguessable name and owner-only access. (#118, #141)
- JavaScript in an HTML preview is trusted per file, not for the whole session. (#123)
- Document headings can no longer clash with app elements, and Export HTML escapes the file name in the title. (#116, #123)

### Project

- A new website with animated demos, published with GitHub Pages. (#151, #158, #165, #166)
- A Code of Conduct, and the update check is disclosed in the README and SECURITY.md. (#160)
- Building from source needs Node.js 22.22.2+, 24.15+ or 26+. (#107)

## [0.3.0] — 2026-09-10

The agent cockpit release.

- **Open Folder** and a welcome screen.
- **Embedded terminal** with tmux-backed tabs that survive restarts, and launch buttons for agent CLIs.
- **Changes** view with git indicators in the tree and a reading diff that hides the noise.
- **Remote folders over SSH**: files, git, terminal and agents on the host, with your own SSH keys.
- **In-app MCP server** so agents in SparkDown terminals can see what you are viewing and review changes.
- **Linux `.deb`** as the preferred install; the AppImage is still built.
- Hardening: the watcher ignores build and dependency folders, a stricter content policy, and dependency security updates.

[0.4.2]: https://github.com/sparkdown/sparkdown/compare/v0.4.1...v0.4.2
[0.3.1]: https://github.com/sparkdown/sparkdown/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/sparkdown/sparkdown/compare/v0.2.0...v0.3.0
