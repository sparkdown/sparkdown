# Changelog

All notable user-visible changes to SparkDown. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Numbers in parentheses are pull
requests.

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

[0.3.1]: https://github.com/sparkdown/sparkdown/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/sparkdown/sparkdown/compare/v0.2.0...v0.3.0
