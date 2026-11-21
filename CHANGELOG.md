# Changelog

All notable user-visible changes to SparkDown. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Numbers in parentheses are pull
requests.

## [0.4.5] — 2026-11-21

### New

- **Send Feedback…** in the Help menu opens a GitHub issue form (Feedback / idea) in your browser, prefilled with the app version and OS. (#229)
- **GitHub issue templates:** Feedback / idea and Bug report forms replace the old markdown templates. (#229)
- **Send feedback** link on the sparkdown.dev website footer. (#229)
- **Regex search in files**: a regex toggle (.*) in the Search sidebar. Local folders use Rust regex syntax (including `\d`, `\w`, and `(?i)`). Remote (SSH) folders use POSIX Extended Regular Expression (ERE) via `grep -E`. For patterns that work in both, use ERE syntax. Invalid patterns show an error. (#234)
- **Terminal notifications**: when a terminal emits OSC 9 or OSC 777 notify (agent CLIs waiting for input), SparkDown shows an OS notification, but only when the window is not focused. Bell (BEL) notifications are a separate setting, off by default. One notification per pane every 10 seconds; configured in Settings → Terminal. (#236)

### Improved

- **Terminal rendering** uses the WebGL renderer when the system GPU supports WebGL2, and falls back to the DOM renderer if WebGL is unavailable or the context is lost. Large terminal output is drawn more efficiently. (#232)
- **Terminal output streaming** sends PTY bytes as binary over a dedicated channel per terminal with flow control, so large output is not held in an unbounded buffer. (#232)
- **Preview** code highlighting loads language modules on demand. The highlight.js core chunk is 8.0 KB gzipped (was 21.8 KB with all languages bundled). Documents with code blocks load only the languages they use. (#235)
- **Window startup** shows the window after the frontend has painted, so launch no longer flashes a blank frame. If the frontend never signals, the window still appears after a short wait. (#238)

### Changed

- Update checks now go through sparkdown.dev, with a fallback to GitHub, and can be turned off in Settings.
- **Git**: Pull and Push now ask before running commands set in a repository's own Git settings, instead of refusing.
- **macOS**: the bundled `sparkdown` command and Install Command in PATH now use `Contents/Resources/resources/bin/sparkdown`, where the app bundle actually keeps the script.

### Fixed

- A window is shown only if it is still hidden, and focus is recorded when it is shown, so a later timeout does not raise a window over one that already has focus.

## [0.4.4] — 2026-11-20

### Improved

- **Diff view** shows direction and invisible characters in the discard dialog, in hunk headers and in git messages. Lines that start with `-- ` or `++ ` are no longer dropped, and the Reading view no longer folds code that follows an import on the same line, or a changed indent, as formatting only.
- **Changes** and Discard keep file names that contain line breaks or tabs exactly as they are.
- **Git** skips the background fetch for repositories set up to fetch through a command or a file, and ftp is no longer used for it. Status, diff, commit and discard stop with a message when a repository's config puts its work tree outside the folder that holds the checkout.
- **Agents**: the window list follows the editor context setting like every other tool, a connection that is not tied to a window gets the same routing message for every tool, and the shared editor context covers only the tabs of the machine the window is connected to.
- **Preview** treats the same path on another machine as a different document, and a file opened straight from your home folder no longer lets every image below it load.
- **Remote (SSH)**: failed remote commands show their output as plain output. Preview images must be inside the open folder, and the folders SparkDown uses on the host must be plain folders owned by your account.
- **macOS**: the `sparkdown` command opens the app it came with instead of any app named SparkDown.
- **Updates**: a downloaded update stays in place until you install it, and is checked once more right before it is installed.
- SparkDown's own preferences, session, review state and log files are readable only by you. Files you save keep your usual permissions.
- **Updates** download only from a release URL of the exact expected shape on github.com, and the app downloads the URL exactly as it was checked.
- **Agents on Windows**: an external agent connection that does not present the current launch's key with its first message is closed, and every message it sent after that is refused.
- **Remote (SSH)**: a terminal's agent tokens are kept in owner-only files in SparkDown's checked cache folder on the host, and the ssh and tmux command lines carry only the file paths.
- **Diff view** marks more invisible characters as `<U+XXXX>`, including the Arabic letter mark, line and paragraph separators, variation selectors, tag characters and other control characters. Tabs and line breaks are shown as before.

### Changed

- **Terminal**: file paths in terminal output open with Ctrl+click (Cmd+click on macOS), like web links. Only files inside the open folder are shown as links.
- **Remote (SSH)**: new hosts always show the fingerprint prompt, whatever `StrictHostKeyChecking` says in `~/.ssh/config`.
- **Remote (SSH)**: SparkDown's own background ssh connections no longer forward your SSH agent or X11, even if `~/.ssh/config` asks for it. The terminal keeps using your own ssh config.
- **Diff view** (Reading mode): a changed leading indent now stays visible instead of being folded as formatting, marked "whitespace only".
- **Preview**: a clicked link opens a file only when it is inside the open folder; with no folder open, only inside the previewed file's folder. Files that agents ask to open, and paths clicked in the terminal, must also be inside the open folder. Files you open yourself (Open dialog, explorer, Quick open, session restore) are not affected, and Ctrl+click (Cmd+click on macOS) on terminal paths inside the folder works as before.
- **Preview**: for a file opened from outside the open folder (or with no folder open), images load only from that file's own folder, not from folders below it. Images inside the open folder load as before.
- **Explorer**: deleting a symbolic link moves the link to the Trash (or deletes it on a remote folder) and leaves the file or folder it points to alone. The confirmation names what the link points to, and links show their target on hover.
- **Git**: Pull and Push stop with a message, instead of running, when the repository's own `.git/config` sets keys that run commands or choose how git connects (such as `core.fsmonitor`, `core.sshCommand`, `credential.helper`, `url.*.insteadOf`, `include.path`, or a remote, push or branch URL using `ext::`, `fd::` or `file://`). These are the settings that already turn off the background fetch; the same settings in your global git config are not affected.
- **Settings**: one preference SparkDown cannot read (for example a theme from a newer version) now falls back to its default on its own instead of resetting every preference. If the preferences file cannot be read as a whole, the other settings are kept, "Share editor context with agents" stays off until you turn it on again, and a copy of the file is saved next to it as `config.json.corrupt-<time>`.
- **Agents**: switching off "Share editor context with agents" now takes effect for every window at once: agents get the "switched off" answer right away, and the unsaved-text copies of every window are removed, not only those of the window where you changed the setting. These copies are also removed when their window closes, when SparkDown quits, and at the next launch if SparkDown was stopped before it could remove them.
- **Remote**: a program that connects to SparkDown's key passphrase helper and then stops talking no longer delays the next passphrase request.

### Fixed

- **Git** status and diff no longer run commands set in a repository's local config.
- Build no longer warns about mixed static/dynamic imports of `@tauri-apps/api/webviewWindow`.
- **Commit** of a renamed file no longer fails or stops the app when other changed files have names with accented or other non-ASCII characters.
- **Remote (SSH)**: saving a file creates its temporary copy as a new file and never writes through a link that is already at that name.
- **Remote (SSH)**: Quick open and Find in folder read file names as whole records, so a name with a line break no longer shows up as a different file; such names are left out of the list.
- **Homebrew**: the cask's `sparkdown` command now points at where the app bundle actually keeps the launcher (`Contents/Resources/resources/bin/sparkdown`); an older cask entry is moved to it on the next release.

## [0.4.3] — 2026-11-13
## [0.4.3] — 2026-11-13

Fixes and reliability improvements on top of 0.4.2.

### Improved

- **Diff view** handles invisible and bidirectional characters better.
- **Search** is faster and more reliable, including preview search and fuzzy file matching in large folders.
- **Preview** stays in sync with the document: diagrams, code blocks, and reference-style links update when the text changes, and images load from the open folder.
- **Git** diffs time out after 20 seconds and skip special file types, with the same behaviour locally and over SSH. Viewing changes no longer runs hooks from the repository or triggers extra fetches in a partial clone. Settings from included config and worktrees are picked up correctly, including names with unusual characters.
- Changes to **editor context** and **background fetch** in Settings apply in every window right away.

### Fixed

- Pasting in the terminal is treated as text when the shell supports it, so a multi-line paste is not run as separate commands.
- Saving a file writes the new contents completely before replacing the old one. Opening unusual or very large files is handled more reliably.
- Creating and deleting files on a remote host stays inside the open folder. Remote connections check all of your known_hosts files when confirming the host, and the SSH key passphrase prompt is tied to that connection.
- JavaScript in an HTML preview stays with that document. Starting Claude from the terminal handles unusual paths correctly.
- The `sparkdown` command only talks to a window running as you, and waits for a clear reply. Agent tools talk only to the window they belong to; on Windows, external agents connect to the right running app, and SparkDown will not replace a path another process is already using.
- SparkDown finds installed agents from your PATH without depending on the current folder, and will not run an agent from a relative path. Background fetch is skipped when a repository's git config customizes how fetch runs.
- Update checks use a fresh folder for each run, and only install the official build that matches the release.
- **Saving while you type** writes the text the editor holds when the write starts, and a save you made yourself no longer makes the next Save ask whether to overwrite. The explorer no longer flashes the row of a file you just saved.
- The **status bar** shows the cursor position of the file you open or switch to, and of a new file.
- A **folder in the explorer** stays open when you click it twice quickly or the list refreshes while it loads, and one failed refresh no longer closes the folders you have open.
- **Terminal:** keys typed right after opening it go to the terminal, in order, instead of the editor or getting lost while the shell starts.

### Changed

- **Agent tools on Linux** without `XDG_RUNTIME_DIR` now use `~/.cache/sparkdown` instead of `/tmp/sparkdown`. macOS is unchanged (still the per-user `$TMPDIR/sparkdown`), and Linux with `XDG_RUNTIME_DIR` set is unchanged. Terminals started before the upgrade need to be restarted to reconnect.
- **Agent tools on a remote (SSH) host** need Python 3 on that host. Terminals that were already open need to be reopened after this upgrade.

## [0.4.2] — 2026-11-09

Terminal, Git and command-line improvements on top of 0.4.1. Not in this
release: the Hyprland work (#186), the WSL agent tools (#187) and the
terminal performance work (#219); they wait for testing on real machines.

