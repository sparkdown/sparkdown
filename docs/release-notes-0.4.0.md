SparkDown 0.4.0 opens **one window per folder**. Work on several projects side by side in one app. Each window has its own files, Changes, search, terminals and remote session, and agents in a window's terminal see only that window's folder. It also includes the 0.3.2 fixes for Windows, SSH and terminals. Full list: [CHANGELOG.md](https://github.com/sparkdown/sparkdown/blob/main/CHANGELOG.md).

### New
- **Multiple windows, one per folder**: opening a folder that is already open focuses its window; an empty window is reused; otherwise a new window opens (#78, #79, #80)
- **New Window** (`Ctrl+Shift+N` / `⌘⇧N`) and a **Window menu** listing every window; titles show the folder (and host for remote) (#81)
- **Open in New Window**: `Ctrl`/`⌘`-click a recent folder, the checkbox in Open Remote, the palette command, or `sparkdown --new-window <folder>` (#84)
- **Recents show open folders**: "● open in window N"; picking one focuses that window. The palette lists recent folders too (#66, #84)
- **Restart restores every window**: folders, open files and terminal layouts (#79)
- **Agents follow their window**: an agent in a window's terminal talks to that window, even after `cd` or a tmux reattach; `sparkdown_list_windows` lists them all (#82, #83)
- **External agents** (outside SparkDown terminals) are off by default; turn them on in Settings → Agents. They must name a folder, or get the focused window when only one is open (#64, #82)
- **One quit prompt** lists running terminals in every window and the windows with unsaved changes (#81, #85)
- `sparkdown <path>` from a terminal opens it in the right window of the running app (#57)

### Fixed (0.3.2)
- Windows: helper processes no longer flash a console window (#18)
- Windows/Linux shortcut keys and labels; Terminals Only in the menus (#19)
- Windows installer: upgrading over a pre-0.3.1 install uninstalls it first (#20)
- Remote: type `user@host[:port]`; first-connect host-key check; in-app SSH key passphrase prompt; clear errors when a server rejects your keys (#26, #38, #39, #56)
- Remote: saved edits reach Changes; the tree shows every row (#34, #35)
- Terminal: `Ctrl+W` stays with the shell on Windows/Linux; closing a busy pane asks first, decided by the foreground process (#40, #44, #54)
- Agent tools: `--mcp-stdio` exits with its parent; configs pointing at a moved SparkDown are detected and repaired; installs time out and show the real error (#37, #41, #55)
- `sparkdown --version` / `--help` print and exit (#36)
- Changes shows an untracked nested repo as a folder (#53)
- macOS: `⌥Z` toggles word wrap (#59)

### Notes
- **Window positions**: restored on macOS, Windows and X11. On Wayland (e.g. Hyprland) the compositor places windows, so only their sizes are restored.
- **Upgrading from 0.3.x**: your settings are kept. The first launch opens one window on your most recent folder with the files you had open in it.
- **Linux binary size**: about 0.7 MB larger than 0.3.1 (+11.6%, 6.3 → 7.1 MB). It comes from the D-Bus libraries the single-instance support pulls in on Linux (#57).

The app checks GitHub for updates once a day and sends no identifier. Turn it off in Settings → Updates.
