# SparkDown on Windows (preview)

Windows support is a **preview**. The app builds and installs on Windows 10
and 11 (x64), and CI compiles the Windows code on every pull request. But no
one tests a full release on a real Windows PC yet, and the installer is not
signed. This page tells you how to build the installer, what works, and what
does not work yet.

## Get the installer

You have two options.

**A. Download a CI build.** Run the **Windows package** workflow
(`.github/workflows/windows-package.yml`: Actions → Windows package → Run
workflow, or a `v*` tag). It uploads the artifact `sparkdown-windows`, which
contains `SparkDown_<version>_x64-setup.exe`. With the GitHub CLI:

```powershell
gh run download --repo sparkdown/sparkdown --name sparkdown-windows --dir $env:TEMP\sparkdown-dl
```

On a tagged Release, the same `.exe` is attached to the Release.

**B. Build it on your PC.** Follow the steps below.

## Build on Windows

### 1. Install the prerequisites (one time)

You do not need administrator rights for the build itself. The installers
for the tools below can ask for them.

| Tool | Get it | Note |
|---|---|---|
| Git | <https://git-scm.com/download/win> | To clone the repository. |
| Node.js | <https://nodejs.org/en/download> | A version that matches `engines` in `frontend/package.json` (`^22.22.2 \|\| ^24.15.0 \|\| >=26`). The LTS release is fine. |
| Rust (stable) | <https://rustup.rs> | Run `rustup-init.exe` and keep the default host `x86_64-pc-windows-msvc`. |
| Visual Studio Build Tools | <https://visualstudio.microsoft.com/visual-cpp-build-tools/> | In the installer, select the workload **Desktop development with C++**. It includes the MSVC compiler and the Windows 11 SDK. |
| WebView2 runtime | <https://developer.microsoft.com/microsoft-edge/webview2/> | Only to run the app. Windows 10 21H2+ and Windows 11 already have it. |

After you install them, **open a new PowerShell window** so that `node`,
`cargo` and `rustc` are on `PATH`.

The full Tauri guide is at <https://tauri.app/start/prerequisites/#windows>.

### 2. Clone and build (one command)

```powershell
git clone https://github.com/sparkdown/sparkdown.git
cd sparkdown
powershell -ExecutionPolicy Bypass -File scripts\package-windows.ps1
```

`-ExecutionPolicy Bypass` applies to this one process only. It does not
change a setting and does not need admin. If your execution policy already
lets you run local scripts, `.\scripts\package-windows.ps1` also works (in
Windows PowerShell 5.1 or PowerShell 7).

The script:

1. Checks each prerequisite. If one is missing, it stops and tells you what
   to install, with a link.
2. Runs `npm ci` in `frontend\`.
3. Runs the Tauri build for the NSIS installer.
4. Prints the path, the size and the SHA-256 of the installer.

The first build takes several minutes (Rust compiles all dependencies). It
also downloads NSIS from GitHub into `%LOCALAPPDATA%\tauri`, so it needs
network access one time. Later builds are faster.

The installer is at:

```
src-tauri\target\release\bundle\nsis\SparkDown_<version>_x64-setup.exe
```

Options:

| Option | What it does |
|---|---|
| `-Msi` | Also builds an `.msi` (WiX, downloaded on the first use) in `bundle\msi\`. WiX needs the Windows optional feature **VBSCRIPT**. Some Windows 11 24H2+ PCs do not have it: if `light.exe` fails, turn on that feature or build without `-Msi`. |
| `-Sign -CertificateThumbprint <SHA-1>` | Signs `sparkdown.exe` and the installers with Authenticode. The certificate must be in `Cert:\CurrentUser\My` (or `Cert:\LocalMachine\My`). `-TimestampUrl` changes the timestamp server (default DigiCert). |
| `-SkipNpmCi` | Uses the `frontend\node_modules` that you already have. |

`Get-Help .\scripts\package-windows.ps1 -Full` shows all options.

### 3. Install

Run `SparkDown_<version>_x64-setup.exe`. It installs **for your user only**
(`%LOCALAPPDATA%\SparkDown`). It does not ask for admin and does not show a
UAC prompt. If the WebView2 runtime is missing, the installer downloads it.

To remove SparkDown: Settings → Apps → Installed apps → SparkDown →
Uninstall.

### Why SmartScreen warns

The installer is **not code-signed**. A code-signing certificate costs money
and needs an identity check, and the project does not have one yet. Windows
SmartScreen thus shows **"Windows protected your PC"** the first time you run
the installer. Click **More info**, then **Run anyway**.

The warning means "unknown publisher", not "malware found". To be sure that
the file is the one CI or you built, compare its SHA-256 with the hash in the
build output:

```powershell
Get-FileHash .\SparkDown_0.3.1_x64-setup.exe -Algorithm SHA256
```

## What works

- Editor, preview, split, diff, tabs, the file tree, search in files, quick
  open and the command palette.
- File associations: the installer registers SparkDown for the same file
  types as on macOS and Linux (Markdown, HTML, SVG, CSV, JSON, YAML, text and
  log files, XML, config/data files). Windows keeps your current default app;
  use **Open with** or Settings → Apps → Default apps to choose SparkDown.
- Window: frameless, with a custom caption (minimize, maximize and close on
  the right) and the app menu under the app icon, as on Linux.
- Keys: `Ctrl` replaces `⌘` and `Alt` replaces `⌥` in the
  [README shortcuts](../README.md#keyboard-shortcuts).
- **Terminal**: it runs PowerShell through ConPTY. It uses PowerShell 7
  (`pwsh.exe`) if it is on `PATH`, else Windows PowerShell 5.1.
- **Agent chips** (Claude Code, Codex, opencode, Gemini, Antigravity, Kiro,
  Grok, Cursor): a chip appears when the agent is on `PATH` as an `.exe`,
  an npm shim (`.cmd` / `.ps1`) or a Store alias (`PATHEXT` lookup). The
  chip opens a PowerShell (the same one as the terminal, with your profile)
  that runs the agent and stays open when the agent exits. The launch line
  is PowerShell syntax, so the **extra flags** in Settings → Agents must be
  too (for example `--model 'opus 4'`). How each agent gets SparkDown's
  tools for the session, with no inline JSON on the command line (Windows
  PowerShell 5.1 strips the `"` from such arguments):
  - Claude Code: `--mcp-config <file>`. SparkDown writes the file,
    `%TEMP%\sparkdown-<pid>-claude-mcp.json` (only the server command, no
    secret), and deletes it when it quits.
  - Codex: `-c` overrides with TOML literal strings (`'C:\...\sparkdown.exe'`).
  - opencode: `$env:OPENCODE_CONFIG_CONTENT`, set for that one run and
    removed after it.
  - The others: their own config after the install prompt (the agent's
    `mcp add`, which SparkDown runs directly, not through a shell; for
    Cursor and Antigravity one entry in their JSON file), else the
    teaching prompt.

  npm installs agents as `.ps1` scripts as well, and PowerShell prefers
  them. If your execution policy blocks scripts (`Restricted`), `claude` /
  `codex` fail in SparkDown as in any PowerShell window; `Set-ExecutionPolicy
  -Scope CurrentUser RemoteSigned` is the usual fix. In a remote (SSH)
  folder, chips run the agent on the remote host with POSIX syntax, as on
  macOS and Linux.
- **MCP server**: agents in SparkDown terminals connect through a per-user
  Windows named pipe (`\\.\pipe\sparkdown-<user>-<random>-mcp`). Only your
  user account and SYSTEM can open it. CI runs the pipe tests on Windows.
- **Updates**: SparkDown checks GitHub Releases (at most once a day) and
  shows when there is a new version. On Windows this is **notify-only**: the
  notice offers **Download**, which opens the release page. Download and run
  the new installer; it upgrades in place. Help → Check for Updates... checks
  now.

## Known limits

- **No tmux persistence.** tmux does not run in ConPTY, so terminal sessions
  do not survive a restart of the app (on macOS and Linux, tmux keeps them).
- **Agent chips are tested in CI only**, with fake npm-style agents in
  PowerShell 7 and 5.1 (not yet with the real agent CLIs on a Windows PC).
  An agent defined only as a function or alias in your PowerShell profile
  gets no chip; type it yourself.
- **Remote (SSH) folders are not tested** on Windows. They use the system
  `ssh` (OpenSSH, part of Windows 10/11).
- **Unsigned installer**: SmartScreen warns (see above). Some managed
  (company) PCs block unsigned installers completely.
- **x64 only.** On Windows on ARM, the x64 build runs under emulation.

## Report a problem

Open an issue at <https://github.com/sparkdown/sparkdown/issues> with the
label `windows` (or "Windows:" in the title). Include:

- Windows version (`winver`) and x64 or ARM.
- How you got the app (CI artifact, Release, or your own build) and its
  version (the installer file name has it).
- For a build failure: the complete output of `scripts\package-windows.ps1`,
  or at least its last 50 lines.
- For an app problem: the steps, what you expected and what happened.
  A screenshot helps for window or rendering problems.

Do not report a security problem in a public issue: see
[SECURITY.md](../SECURITY.md).
