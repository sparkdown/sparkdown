# Security

## Reporting a vulnerability

Please do not open public issues for security vulnerabilities. Report them
privately via GitHub's **Security → Report a vulnerability** on this
repository. We aim to acknowledge reports within a few days.

## Threat model

SparkDown is a local desktop application. It has **no network-listening
server, no TCP port, no accounts, and no authentication**. It reads and writes
files the user chooses, runs the user's `git`, runs shells in an embedded
terminal, and — when the user asks — opens outbound SSH connections to hosts in
the user's own `~/.ssh/config`.

Two adversaries shape the design:

1. **A malicious document** — a `.md`, `.html`, or `.svg` file from an
   untrusted source (downloaded, shared, or in a cloned repo) that the user
   opens. Opening such a file must not:
   - execute code with the app's privileges,
   - read or exfiltrate other files on the machine,
   - run arbitrary code without an explicit, informed user action.

2. **A misbehaving or hijacked agent** — SparkDown is a cockpit for coding
   agents that the user runs *themselves* in the embedded terminal. The agent
   is semi-trusted: the user chose to run it, and it already has the user's
   shell. SparkDown's job is not to sandbox the agent, but to make sure the
   surfaces SparkDown *adds* (the MCP server, the context bridge, the remote
   forward) do not widen what a process on the machine can reach, and that
   nothing an agent does through them touches disk without the user's review.

Secondary untrusted inputs are the file **paths** delivered via macOS
"Open With", command-line arguments, and drag-and-drop.

Out of scope: what the user (or an agent the user runs) does with their own
shell in the embedded terminal. That terminal is a real PTY running the user's
login shell; it can do anything the user can. tmux (when installed) persists
those sessions across app restarts. SparkDown does not confine it and does not
claim to.

## Why the model holds (the invariants)

These properties are what keep a malicious document contained. **Changing any
of them can turn a rendering bug into arbitrary file access — treat them as
load-bearing.**

1. **The privileged frame runs no document script.** The main webview holds
   the Tauri IPC bridge (`read_file`, `write_file`, `list_directory`, …). The
   app CSP (`src-tauri/tauri.conf.json`) sets `script-src 'self'`
   with **no `'unsafe-inline'`** (and no `'unsafe-eval'`), so inline scripts, `javascript:` URLs, and
   `<script>` injected via markdown-rendered `innerHTML` do not execute. Do
   not add `'unsafe-inline'` to `script-src`, and do not move markdown
   rendering to a non-CSP origin.

2. **IPC is main-frame-only.** Tauri injects the IPC bridge only into the main
   frame (`for_main_frame_only`), and the HTML/SVG preview is always a
   subframe. So even a document that somehow ran script could not call
   `invoke()`. Do not enable `withGlobalTauri`, and do not render untrusted
   content in the main frame.

3. **The scripts-off preview cannot run script.** HTML/SVG previews default to
   a `srcdoc` iframe sandboxed `allow-same-origin` **without** `allow-scripts`
   (`frontend/src/preview.ts`). `allow-same-origin` alone does not enable
   scripting; it exists so the parent can read the framed DOM for in-preview
   search.

4. **The scripts-on preview is opt-in and contained.** Enabling JavaScript for
   an HTML preview is a per-session, per-user action gated behind a
   confirmation dialog; it never persists and cannot be triggered by document
   content. When enabled, the document is served from the `htmlpreview://`
   custom protocol. Enabling scripts is a "run this document fully" action:
   it executes the document's own JavaScript **and** the remote framework /
   CDN assets real web documents (reveal.js decks, charting libraries, …)
   need to function. The response CSP therefore permits `https:` and inline
   script/style and network egress — a locked-down `connect-src` would be
   security theater once remote `<script src>` is allowed at all, since such a
   script can exfiltrate freely regardless.

   What contains a malicious document does **not** depend on this CSP and
   still holds with scripts on:
   - **It cannot read other local files.** The preview runs on a distinct
     `htmlpreview://` origin, and the asset protocol stamps
     `Access-Control-Allow-Origin` scoped to the app origin, so cross-origin
     reads of `asset:`/local content are blocked.
   - **It cannot reach Tauri IPC** (invariant 2 — IPC is main-frame-only; the
     preview is a subframe).
   - **It cannot hijack the app window.** The scripts-mode iframe sandbox is
     `allow-scripts` only — no `allow-top-navigation` (window takeover / UI
     redress) and no `allow-same-origin`. `frame-ancestors 'self'` keeps only
     the app able to frame it.

   Do not add `allow-top-navigation` or `allow-same-origin` to this iframe.
   The network-permissive CSP is an accepted consequence of the explicit,
   dialog-gated opt-in; the file-confidentiality and IPC guarantees above are
   the load-bearing ones and must not be weakened.

5. **File paths from the frontend are validated in Rust.** `validate_path` /
   `validate_write_path` (`src-tauri/src/commands.rs`) canonicalize paths,
   resolving `..` and symlinks, before any filesystem access. The native
   `copy_file` clipboard action passes the path as a discrete `argv` item to
   `osascript` (never string-interpolated into the AppleScript), so there is
   no command injection.

6. **The app window never navigates away.** Link clicks in the markdown
   preview are intercepted (`PreviewPane.interceptLinks`): `#id` scrolls,
   local text files open in a tab, `http(s):`/`mailto:` go to the system
   browser via `open_external` (scheme-validated in Rust, URL passed as one
   `argv` item to `open` / `xdg-open` / `url.dll,FileProtocolHandler`), and
   everything else is dropped. In defence of that, a `navigation-guard`
   plugin (`src-tauri/src/main.rs`) cancels any webview navigation outside
   the app origin and the preview iframe's sources (`about:srcdoc`,
   `htmlpreview://`, `asset:`). Because WebKit applies the guard to
   subframes too, remote `<iframe>` embeds inside a scripts-on HTML preview
   are blocked.

7. **Rendered markdown HTML is sanitized before it reaches the DOM.** The
   preview runs `marked` output through DOMPurify with an explicit tag/attribute
   allowlist and a URL-scheme allowlist (`sanitizeMarkdownHtml`,
   `frontend/src/preview.ts`) before every `innerHTML` write. `href`/`src`
   values outside the allowlist (`http(s):`, `mailto:`, `tel:`, `asset:`,
   `data:image/...`, and relative URLs) are stripped, and `data-*` attributes
   are dropped. This is a second layer under the CSP (invariant 1), not a
   replacement for it — both must hold.

## Added surfaces (agent cockpit)

The cockpit features add local IPC and outbound SSH. None of them opens a
network-listening port, and each is designed so it does not widen a
document's or a stranger's reach.

- **In-app MCP server** (`src-tauri/src/mcp.rs`, `mcp_stdio.rs`). Agents in the
  embedded terminal discover SparkDown over MCP. Transport is newline-delimited
  JSON-RPC over a **Unix domain socket** at `<runtime dir>/sparkdown/mcp.sock`
  (parent dir created `0700`, socket `0600`); on Windows, a **per-user named
  pipe** (`\\.\pipe\sparkdown-<user>-mcp`). There is no HTTP, no port, and no
  token — **filesystem permissions are the access control**, so only the
  logged-in user can connect. The socket is removed on quit.
  - **Env-var gate.** Agents never open the socket directly. They run this same
    binary as a stdio MCP server (`sparkdown --mcp-stdio`), which forwards to
    the socket named by `$SPARKDOWN_MCP`. That variable is exported **only in
    SparkDown's own terminals**. Anywhere else it is unset and the shim
    advertises **zero tools**, so an installed agent config is silent outside
    SparkDown.
  - **Read tools read an in-memory snapshot.** The frontend pushes editor
    state (`mcp_publish`); tools read that snapshot, so unsaved buffer text
    served to an agent never touches disk.
  - **One write tool, and it writes nothing to disk.** `sparkdown_edit_buffer`
    edits the *unsaved editor buffer* through a round trip to the frontend; the
    user reviews, undoes, or saves. SparkDown never writes the file itself and
    never runs the agent.
  - **User off-switch.** Context sharing is gated by Settings → Agents. When
    off (`enabled = false`), every tool returns a refusal instead of data.

- **Remote MCP forward** (`src-tauri/src/remote/mcp_shim.sh`, `remote/mod.rs`).
  For a remote workspace, SparkDown installs a small shim under
  `~/.cache/sparkdown/` on the host and **reverse-forwards** the local MCP
  socket over the existing SSH connection (a `-R` remote Unix-socket forward)
  so remote agents reach the same in-app server. The same `$SPARKDOWN_MCP`
  gate applies on the host: outside a SparkDown terminal the shim answers with
  zero tools.

- **SSH remote sessions** (`src-tauri/src/remote/`). File → Open Remote Folder
  runs the editor, explorer, Changes, watcher, and terminal against a folder on
  a host from `~/.ssh/config`. SparkDown **adds no crypto stack**: it shells out
  to the system `ssh` with `BatchMode=yes` and **public-key auth only** (it
  never prompts for or handles a password), multiplexed over a control (mux)
  connection. It uses the user's existing keys and config; there is no cloud
  and no SparkDown-hosted relay.

- **Agent MCP config install** (`mcp_install_agent` / `mcp_uninstall_agent`).
  A persistent install happens only with the user's explicit consent: from
  Settings → Agents, or the **Install** button of the prompt shown when an
  agent chip launches Gemini, Grok, Kiro, Cursor or Antigravity without
  SparkDown installed ("Not now" and "Don't ask again" change nothing on disk
  except SparkDown's own config). Claude Code, Codex and opencode are never
  installed implicitly: they get the server for the launched session only
  (`--mcp-config` / `-c` / the `OPENCODE_CONFIG_CONTENT` environment
  variable, all additive; nothing is written).
  For Claude Code, Codex, Grok, Kiro and Gemini, SparkDown does **not** write
  the config files itself: it runs the agent's own `mcp add` / `mcp remove`
  CLI in the login shell, with a timeout and its own process group so a hung
  CLI is killed cleanly. The shim path is shell-quoted. Install status is read
  directly from the agent's config file (a plain read), never by running the
  CLI.
  **Cursor CLI** and **Antigravity CLI** (`agy`) have no `mcp add` command,
  so with consent SparkDown writes **one** entry itself:
  `mcpServers.sparkdown` in `~/.cursor/mcp.json` (Cursor) or
  `~/.gemini/config/mcp_config.json` (Antigravity) (`command` = the shim,
  `args`, and `env` naming only `SPARKDOWN_MCP` in the agent's own
  interpolation syntax, so the gate variable reaches the shim; no value is
  stored). The file is parsed as JSON (key order kept); every other key and
  server is kept; the write is atomic (temp file + rename) and keeps the
  existing file's mode. Missing folders / file are created owner-only
  (`0700` / `0600`). Gemini CLI's own `~/.gemini/settings.json` is never
  touched. If the file is not valid JSON (or not
  an object), SparkDown refuses and leaves it unchanged. Remove deletes only
  that one entry. In a remote workspace the host's file is read over SSH,
  merged locally, and written back with the size-checked atomic remote write.

- **Agent context bridge** (`src-tauri/src/context.rs`). The older, prompt-based
  channel: the terminal exports `$SPARKDOWN_CONTEXT` pointing at an owner-only
  (`0700`) temp folder holding a JSON snapshot of what the user is viewing
  (including unsaved buffer text). It is written only while a terminal is open,
  removed on quit, and covered by the same Settings → Agents off-switch.

## Auto-update

SparkDown has a small built-in updater (`src-tauri/src/updates.rs`, UI in
`frontend/src/updater.ts`). This is the only outbound HTTPS the app makes on
its own: one GET of
`https://github.com/sparkdown/sparkdown/releases/latest/download/latest.json`
shortly after launch, at most once per 24 h (Settings → Updates turns it off),
plus the manual "Check for Updates...". No identifier or telemetry is sent
beyond a `SparkDown/<version>` user agent and the HTTP request itself.

- **Transport.** The app has no HTTP/TLS library. It runs the system `curl`
  (`/usr/bin/curl` when present) with `--proto =https --proto-redir =https
  --tlsv1.2`, time and size limits, and the URL passed via `--url` (never as
  an option). curl is killed if it overruns its time limit.
- **Signature verification.** Every update artifact (the macOS
  `.app.tar.gz`, the Linux AppImage) is signed with a minisign key held only by
  the maintainer (`~/.tauri/sparkdown-updater.key`, and the
  `TAURI_SIGNING_PRIVATE_KEY` repo secret for the Linux CI build), in the
  format `tauri signer sign` writes. The public key is compiled into the app
  (`src-tauri/updater-pubkey.txt`). The download is verified with
  `minisign-verify` against that key **before** anything is written to the
  install location; a missing or bad signature aborts the update. TLS to
  GitHub is a second layer, not the trust anchor: a compromised release page
  or CDN cannot ship code without the private key.
- **Downgrade protection.** The version in the signature's trusted comment
  (covered by minisign's global signature, and read only after it verifies)
  must equal the version `latest.json` announces, and signatures without a
  version are rejected. So a tampered manifest cannot pair a new version
  number with an older, validly signed build. Only strictly newer versions
  (semver) are offered.
- **Install.** The update is staged in a folder next to the installed app
  (same filesystem) and swapped in with renames: old → backup, new → in
  place, then the backup is removed; any failure renames the backup back.
  The app never asks for more privileges: if its folder is not writable
  (e.g. a root-owned `/Applications`, a translocated or DMG-mounted app), it
  only offers a link to the release page.
- **Placeholder key.** Until a real public key is configured, the app detects
  the placeholder and skips update checks entirely (no network request).
- **User consent.** Nothing is downloaded until the user clicks Install. The
  relaunch runs the normal unsaved-changes prompt first; Cancel aborts it.
- **Key loss or leak.** A leaked private key lets its holder sign updates that
  every installed copy accepts; a lost key means installed copies can no
  longer auto-update (users reinstall once from Releases). Keep the key
  offline-backed-up and password-protected. The release scripts keep it out
  of the environment of npm/vite/cargo build steps and pass it only to
  `tauri signer sign`.
- **Package-manager installs** (`.deb`, AUR) are never modified by the app: it
  only shows that a new version exists. Only the macOS `.app` and the Linux
  AppImage self-update.

## Known accepted risks

- `read_file` / `write_file` are not confined to a base directory, and the
  asset-protocol scope is broad. This is intentional for a general-purpose
  local editor and is safe **only because** invariants 1–2 make these commands
  unreachable from document content. Any change that weakens 1 or 2 must
  re-evaluate this.
- The embedded terminal, tmux persistence, and SSH remote sessions run with the
  user's full privileges by design (see Threat model — out of scope). SparkDown
  does not sandbox commands the user or their agent runs.
- The MCP server trusts any local process that can open the socket/pipe — i.e.
  any process running as the same user. On a single-user machine this is the
  intended boundary; the env-var gate additionally keeps the tools silent
  outside SparkDown's own terminals, but it is a usability/opt-in gate, not a
  second authentication factor.

## Audit status

A full-codebase security review was performed before the **v0.2.0** release,
covering the Tauri command boundary, the preview sandboxing model, the custom
protocol handler, CSP, and markdown-rendering XSS. No high-severity findings;
the scripts-on preview was hardened (response CSP + iframe sandbox +
confirmation dialog) as a result.

That audit **predates the agent-cockpit surfaces** added since: the in-app MCP
server and remote MCP forward, SSH remote sessions, embedded terminals/tmux,
the agent MCP config install, and DOMPurify sanitization. Those have not had an
equivalent independent review. A professional third-party audit — covering the
new surfaces — is recommended before any public, signed distribution.
