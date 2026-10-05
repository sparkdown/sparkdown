SparkDown 0.3.1 is a new layout built around reviewing what your agent changed. An activity bar, quick open and a command palette put every view one key away. Each tab has its own Edit | Split | Preview | Diff view, terminals split into panes, and Changes is now a review queue. The app also updates itself (signed), and many fixes make saves safer, locally and over SSH. Full list: [CHANGELOG.md](https://github.com/sparkdown/sparkdown/blob/main/CHANGELOG.md).

### New
- **Activity bar**: Files, Changes, Search in files, Remote and Settings (#144)
- **Search in files** over the open folder, local or remote (#144)
- **Quick open** (`⌘P`) and a **command palette** (`⌘⇧P`) (#145)
- **Per-document view**: Edit | Split | Preview | Diff (`⌘1`–`⌘4`) (#146)
- **Status bar**: path, git branch with ahead/behind, remote host, agent tools state, character count (#100, #146)
- **Terminal splits** up to 4 panes, restored after a restart with tmux; **Terminals Only** layout (#143, #108)
- **Changes review queue**: reviewed marks, progress meter, +/− counts, `↑`/`↓` and `Space` (#148, #149)
- **Remote file picker** for Open, Save As and Export over SSH (#129, #139)
- **Signed auto-updates** for the macOS app and the Linux AppImage (#130, #140)
- **More agents**: opencode and Antigravity join the chips; Gemini, Grok, Kiro, Cursor and Antigravity ask once at launch to install SparkDown's tools (#161, #163)
- **Windows build script and installer (preview)**: `scripts\package-windows.ps1`, see [docs/windows.md](https://github.com/sparkdown/sparkdown/blob/main/docs/windows.md) (#167)

### Fixed
- Remote saves check the size before replacing a file, so a dropped connection cannot leave a partial file (#132, #141)
- Local and remote saves are atomic and keep symlinks (#110)
- A file changed on disk while you edit it is marked, and Save asks before it overwrites (#109)
- Tabs are never saved to the wrong machine after you connect or disconnect (#111, #133)
- Keys typed in Diff or Preview no longer edit the hidden document (#159)
- Folders opened through a symlink show git changes correctly (#152, #155)
- tmux sessions: no status line, correct environment, commands reach the right pane (#117, #152, #154)
- `Ctrl+Q` on Windows/Linux asks about unsaved changes (#109)
- The macOS app no longer shows as "damaged" after download (#135)
- Agents get exact lines by number (`sparkdown_get_lines`), and Codex now gets SparkDown's tools (#163, #164)

### Security
- Untrusted repositories cannot run git filters when you view changes (#120)
- Preview links cannot navigate the app; tighter image scope and content policy (#112, #118)
- Owner-only MCP pipe on Windows and a hardened agent context folder (#118, #141)

The app checks GitHub for updates once a day and sends no identifier. Turn it off in Settings → Updates.
