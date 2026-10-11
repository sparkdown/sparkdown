/**
 * Remote sessions v1 (#36): pick a Host from ~/.ssh/config, open one remote
 * folder, and let the existing editor / explorer / Changes / terminal talk
 * to it. The Rust side shells out to `ssh` (keys only). This module is the
 * UI + a RemoteHandler that App.openFolder routes through (see
 * App.setRemoteHandler) — it does not rewrite the editor.
 */
import { listen } from '@tauri-apps/api/event';
import { message } from '@tauri-apps/plugin-dialog';
import { api, type RemoteSession, type SshHost } from './api';
import { MENU } from './event-names';
import { trapFocus, type ModalHandle } from './modal';
import { showContextMenu } from './context-menu';

/**
 * App's extension point for remote sessions. App.openFolder hands every
 * folder request to the registered handler, which may connect / disconnect
 * first and then calls `openResolved` with the concrete path to make it the
 * workspace (or not at all, if the user cancelled).
 */
export interface RemoteHandler {
  openFolder(dir: string, openResolved: (dir: string) => Promise<void>): Promise<void>;
  /** Called once the App UI is built (at once if it already is): inject the
   *  menu / welcome / status-chip UI and pick up a surviving session. */
  attach(): void;
  /** Show the "Open Remote Folder" dialog (menu / shortcut / toolbar). */
  openRemoteDialog?(): void;
}

export interface RemoteApp {
  /** Register the folder-open router. Safe to call before App.init(). */
  setRemoteHandler(handler: RemoteHandler): void;
  /** Open a folder through the router (a local path or ssh://host/path). */
  openFolder(dir: string): Promise<void>;
  /** Tell the status bar the remote root, so file paths show as ~/relative
   *  next to the host chip (null = local again, show full paths). */
  setRemotePathBase(base: string | null): void;
  /** Persist a recent-folders entry (local path or ssh://host/path). */
  rememberRecentFolder(entry: string): void;
  /** Before the active machine changes (connect / disconnect / host switch):
   *  resolve dirty tabs from other machines. False = user cancelled. */
  prepareOriginSwitch(target: string | null): Promise<boolean>;
  /** After the backend switched: close other-machine tabs, stamp new tabs,
   *  reset the workspace (tree, watcher, Changes, terminal cwd). */
  commitOriginSwitch(target: string | null): void;
  /** The backend switch failed after prepareOriginSwitch returned true: the
   *  machine did not change, so undo what prepare paused. */
  cancelOriginSwitch(): void;
}

/** Thrown when the user cancels the unsaved-changes prompt of a switch. */
export class OriginSwitchCancelled extends Error {
  constructor() {
    super('Cancelled: unsaved changes were kept.');
    this.name = 'OriginSwitchCancelled';
  }
}

/** Recent-folders encoding for remote workspaces. Keeps AppConfig as
 *  `string[]` while carrying host + absolute path. Form: `ssh://host/abs/path`. */
export const REMOTE_RECENT_PREFIX = 'ssh://';

export type RemoteRecent = { host: string; path: string };

/**
 * Client-side mirror of the backend's parse_destination (remote/ssh.rs), for
 * instant feedback: `[user@]host[:port]`, IPv6 in brackets. The backend
 * check is the authoritative one.
 */
export function isValidTypedHost(s: string): boolean {
  if (s.length === 0 || s.length > 255) return false;
  const m = /^(?:([A-Za-z0-9._][A-Za-z0-9._-]{0,63})@)?(?:\[([0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*)\]|([A-Za-z0-9_][A-Za-z0-9._-]*))(?::([0-9]{1,5}))?$/.exec(s);
  if (!m) return false;
  if (m[4] !== undefined) {
    const port = Number(m[4]);
    if (port < 1 || port > 65535) return false;
  }
  return (m[3] ?? m[2] ?? '').length <= 253;
}

export function formatRemoteRecent(host: string, path: string): string {
  const abs = path.startsWith('/') ? path : `/${path}`;
  return `${REMOTE_RECENT_PREFIX}${host}${abs}`;
}

export function parseRemoteRecent(entry: string): RemoteRecent | null {
  if (!entry.startsWith(REMOTE_RECENT_PREFIX)) return null;
  const rest = entry.slice(REMOTE_RECENT_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const host = rest.slice(0, slash);
  const path = rest.slice(slash);
  if (!host || !path) return null;
  return { host, path };
}

export function isRemoteRecent(entry: string): boolean {
  return parseRemoteRecent(entry) !== null;
}

/** Client-side guard matching the Rust password-only check, so the dialog
 *  can fail clearly without an SSH round-trip. Backend still enforces it. */
export function passwordOnlyMessage(host: string): string {
  return (
    `Host '${host}' is configured for password authentication. ` +
    `SparkDown v1 uses existing SSH keys only — add an IdentityFile ` +
    `(or load a key in ssh-agent) in ~/.ssh/config. There is no password prompt.`
  );
}

interface OpenDialog {
  overlay: HTMLElement;
  modal: ModalHandle;
  onKey: (e: KeyboardEvent) => void;
}

/**
 * Remote-session UI and folder-open routing for one App. All state (the
 * status chip, the open dialog and its key handler / focus trap) lives on
 * the instance, so each App — and each test — gets a fresh one.
 */
export class RemoteSessions {
  private statusEl: HTMLElement | null = null;
  /** The open "Open Remote Folder" dialog, if any. */
  private dialog: OpenDialog | null = null;

  constructor(private readonly app: RemoteApp) {}

  /** Register on the App: folder opens route through this instance
   *  (picking a local folder disconnects the single remote workspace;
   *  `ssh://host/path` recent entries reconnect instead of a silent local
   *  open), and the menu / welcome / status-chip UI attaches once the App is
   *  ready. Safe to call before or after App.init(). */
  install(): this {
    this.app.setRemoteHandler({
      openFolder: (dir, openResolved) => this.routeFolderOpen(dir, openResolved),
      attach: () => this.attach(),
      openRemoteDialog: () => void this.openDialog(),
    });
    return this;
  }

  /** RemoteHandler.openFolder: reconnect for ssh:// entries, else open the
   *  path (leaving the remote workspace if it is a different folder). */
  private async routeFolderOpen(
    dir: string,
    openResolved: (dir: string) => Promise<void>,
  ): Promise<void> {
    const openPath = (path: string) => this.openResolvedPath(path, openResolved);
    const remote = parseRemoteRecent(dir);
    if (remote) {
      try {
        await this.reopen(remote.host, remote.path, openPath);
      } catch (e) {
        if (e instanceof OriginSwitchCancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        await message(
          `Could not open remote folder ssh ${remote.host}:${remote.path}.\n\n${msg}`,
          { title: 'Remote Folder', kind: 'error' },
        );
      }
      return;
    }
    await openPath(dir);
  }

  /** Open a concrete (already-resolved) path; disconnect if leaving remote. */
  private async openResolvedPath(
    dir: string,
    openResolved: (dir: string) => Promise<void>,
  ): Promise<void> {
    const session = await api.remoteSession().catch(() => null);
    if (session && dir !== session.path) {
      if (!(await this.disconnect())) return;
    }
    await openResolved(dir);
    // openFolder remembered the bare remote path; rewrite as ssh://host/path
    // so welcome-screen clicks can reconnect.
    const after = await api.remoteSession().catch(() => null);
    if (after && after.path === dir) {
      this.app.rememberRecentFolder(formatRemoteRecent(after.host, after.path));
    }
  }

  /** RemoteHandler.attach: menu / welcome / status-chip UI, and a session
   *  that outlived a webview reload. */
  private attach(): void {
    void listen(MENU.OPEN_REMOTE, () => {
      void this.openDialog();
    });
    this.injectWelcomeButton();
    this.injectStatusChip();
    void api
      .remoteSession()
      .then((s) => {
        this.renderStatusChip(s);
        this.app.setRemotePathBase(s?.path ?? null);
        // A session that outlived a webview reload: tabs restored as local
        // were read over SSH, so drop them and stamp new tabs with the host.
        if (s) this.app.commitOriginSwitch(s.host);
      })
      .catch(() => undefined);
  }

  private injectWelcomeButton(): void {
    const actions = document.getElementById('welcome-actions');
    if (!actions || document.getElementById('welcome-open-remote')) return;
    const btn = document.createElement('button');
    btn.id = 'welcome-open-remote';
    btn.className = 'welcome-btn';
    btn.type = 'button';
    btn.dataset.welcome = 'open-remote';
    btn.textContent = 'Open Remote Folder…';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.openDialog();
    });
    const primary = actions.querySelector('.welcome-btn-primary');
    if (primary?.nextSibling) actions.insertBefore(btn, primary.nextSibling);
    else actions.appendChild(btn);
  }

  /** The host chip in the status bar (`ssh <host>`, after the path and
   *  branch). index.html has its slot; a shell without one gets it after
   *  the path. Clicking it opens a menu: disconnect, or switch to another
   *  remote folder. */
  private injectStatusChip(): void {
    const bar = document.getElementById('status-bar');
    if (!bar || this.statusEl?.isConnected) return;
    let chip = document.getElementById('status-remote');
    if (!chip) {
      chip = document.createElement('button');
      chip.id = 'status-remote';
      chip.className = 'status-item status-remote hidden';
      const label = document.createElement('span');
      label.className = 'status-remote-label';
      chip.appendChild(label);
      const path = document.getElementById('status-path');
      bar.insertBefore(chip, path ? path.nextSibling : bar.firstChild);
    }
    chip.setAttribute('aria-haspopup', 'menu');
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      const r = chip!.getBoundingClientRect();
      this.showChipMenu(r.left, r.top);
    });
    this.statusEl = chip;
  }

  /** The chip's menu, anchored above it (the status bar is at the bottom). */
  private showChipMenu(x: number, y: number): void {
    showContextMenu(x, Math.max(0, y - 84), [
      { label: 'Disconnect', onClick: () => void this.disconnect() },
      { label: 'Open Another Remote Folder…', onClick: () => void this.openDialog() },
    ]);
  }

  renderStatusChip(session: RemoteSession | null): void {
    const chip = this.statusEl;
    if (!chip) return;
    const label = chip.querySelector<HTMLElement>('.status-remote-label');
    if (!session) {
      chip.classList.add('hidden');
      chip.title = '';
      if (label) label.textContent = '';
      return;
    }
    chip.classList.remove('hidden');
    if (label) label.textContent = `ssh ${session.host}`;
    // The full root lives in the tooltip; the path element next to the chip
    // shows each file relative to it.
    chip.title = `Remote session: ${session.host}:${session.path} (click to disconnect or switch)`;
  }

  /** Backend disconnect wrapped in the tab-origin switch. False = cancelled. */
  async disconnect(): Promise<boolean> {
    if (!(await this.app.prepareOriginSwitch(null))) return false;
    await api.remoteDisconnect().catch(() => undefined);
    this.renderStatusChip(null);
    this.app.setRemotePathBase(null);
    this.app.commitOriginSwitch(null);
    return true;
  }

  /** Reuse the live session when host+path match; otherwise connect fresh. */
  async reopen(
    host: string,
    path: string,
    openFolder: (dir: string) => Promise<void>,
  ): Promise<RemoteSession> {
    const current = await api.remoteSession().catch(() => null);
    if (current && current.host === host && current.path === path) {
      this.renderStatusChip(current);
      this.app.setRemotePathBase(current.path);
      await openFolder(current.path);
      return current;
    }
    return this.connect(host, path, openFolder);
  }

  async connect(
    host: string,
    path: string,
    openFolder: (dir: string) => Promise<void>,
  ): Promise<RemoteSession> {
    // Resolve dirty tabs of the current machine while its routing is active.
    if (!(await this.app.prepareOriginSwitch(host))) {
      throw new OriginSwitchCancelled();
    }
    let session: RemoteSession;
    try {
      session = await api.remoteConnect(host, path);
    } catch (e) {
      this.app.cancelOriginSwitch();
      throw e;
    }
    this.app.commitOriginSwitch(session.host);
    this.renderStatusChip(session);
    // Set the base before opening the folder, so the first status-bar render
    // already shows ~/relative paths.
    this.app.setRemotePathBase(session.path);
    await openFolder(session.path);
    return session;
  }

  /** Show the "Open Remote Folder" dialog (replacing one already open). */
  async openDialog(): Promise<void> {
    this.closeDialog();

    const hosts = await api.sshConfigHosts().catch(() => [] as SshHost[]);

    const overlay = document.createElement('div');
    overlay.className = 'remote-overlay';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.closeDialog();
    });

    const dialog = document.createElement('div');
    dialog.className = 'remote-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', 'Open remote folder');
    dialog.tabIndex = -1;

    const header = document.createElement('div');
    header.className = 'remote-header';
    const title = document.createElement('h2');
    title.textContent = 'Open Remote Folder';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'remote-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.title = 'Close (Esc)';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => this.closeDialog());
    header.append(title, closeBtn);
    dialog.appendChild(header);

    const hint = document.createElement('p');
    hint.className = 'remote-lead';
    hint.textContent =
      'Pick a host from ~/.ssh/config or type one (user@host or user@host:port). Auth uses your SSH keys and agent; SparkDown never asks for the server password and never hosts the files.';
    dialog.appendChild(hint);

    const hostLabel = document.createElement('label');
    hostLabel.className = 'remote-field';
    hostLabel.textContent = 'Host';
    const hostSelect = document.createElement('select');
    hostSelect.id = 'remote-host';
    hostSelect.setAttribute('aria-label', 'SSH host');
    if (hosts.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No hosts in ~/.ssh/config';
      hostSelect.appendChild(opt);
      hostSelect.disabled = true;
    } else {
      for (const h of hosts) {
        const opt = document.createElement('option');
        opt.value = h.alias;
        const extra = h.password_only ? ' (password-only — unavailable)' : '';
        const dest = h.hostname ?? h.alias;
        opt.textContent = `${h.alias} — ${dest}${extra}`;
        opt.disabled = h.password_only;
        hostSelect.appendChild(opt);
      }
      const firstOk = hosts.find((h) => !h.password_only);
      if (firstOk) hostSelect.value = firstOk.alias;
    }
    hostLabel.appendChild(hostSelect);
    dialog.appendChild(hostLabel);

    // #22: a host that isn't in ~/.ssh/config. Validated strictly by the
    // backend (parse_destination) and handed to ssh as argv, so ssh's own
    // config, keys and agent still apply.
    const typedLabel = document.createElement('label');
    typedLabel.className = 'remote-field';
    typedLabel.textContent = hosts.length ? 'Or type a host' : 'Host';
    const typedInput = document.createElement('input');
    typedInput.id = 'remote-host-typed';
    typedInput.type = 'text';
    typedInput.placeholder = 'user@host or user@host:port';
    typedInput.autocomplete = 'off';
    typedInput.spellcheck = false;
    typedInput.setAttribute('autocapitalize', 'off');
    typedInput.setAttribute('aria-label', 'SSH host (user@host[:port])');
    typedLabel.appendChild(typedInput);
    dialog.appendChild(typedLabel);
    if (hosts.length === 0) hostLabel.classList.add('hidden');

    const pathLabel = document.createElement('label');
    pathLabel.className = 'remote-field';
    pathLabel.textContent = 'Remote folder';
    const pathInput = document.createElement('input');
    pathInput.id = 'remote-path';
    pathInput.type = 'text';
    pathInput.value = '~';
    pathInput.placeholder = '~/src/project';
    pathInput.setAttribute('aria-label', 'Remote folder path');
    pathLabel.appendChild(pathInput);
    dialog.appendChild(pathLabel);

    const err = document.createElement('p');
    err.className = 'remote-error hidden';
    err.setAttribute('role', 'alert');
    dialog.appendChild(err);

    const actions = document.createElement('div');
    actions.className = 'remote-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'remote-btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.closeDialog());
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'remote-btn remote-btn-primary';
    go.textContent = 'Connect';
    const syncGo = () => {
      go.disabled = hosts.length === 0 && typedInput.value.trim() === '';
      hostSelect.disabled = hosts.length === 0 || typedInput.value.trim() !== '';
    };
    typedInput.addEventListener('input', syncGo);
    syncGo();
    const showError = (msg: string) => {
      err.textContent = msg;
      err.classList.remove('hidden');
    };
    const submit = async (): Promise<void> => {
      err.classList.add('hidden');
      const typed = typedInput.value.trim();
      if (typed && !isValidTypedHost(typed)) {
        showError(`"${typed}" is not a valid host. Use user@host, host, or user@host:port.`);
        return;
      }
      const alias = typed || hostSelect.value;
      if (!alias) {
        showError('Type a host (user@host[:port]) or add one to ~/.ssh/config.');
        return;
      }
      const host = hosts.find((h) => h.alias === alias);
      if (host?.password_only) {
        showError(passwordOnlyMessage(alias));
        return;
      }
      go.disabled = true;
      go.textContent = 'Connecting…';
      try {
        await this.connect(alias, pathInput.value.trim() || '~', (dir) => this.app.openFolder(dir));
        this.closeDialog();
      } catch (e) {
        if (!(e instanceof OriginSwitchCancelled)) {
          showError(e instanceof Error ? e.message : String(e));
        }
        go.disabled = false;
        go.textContent = 'Connect';
      }
    };
    go.addEventListener('click', () => void submit());
    for (const input of [pathInput, typedInput]) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void submit();
        }
      });
    }
    actions.append(cancel, go);
    dialog.appendChild(actions);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    const modal = trapFocus(dialog);
    dialog.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeDialog();
      }
    };
    document.addEventListener('keydown', onKey);
    this.dialog = { overlay, modal, onKey };
  }

  closeDialog(): void {
    const open = this.dialog;
    if (!open) return;
    this.dialog = null;
    document.removeEventListener('keydown', open.onKey);
    open.overlay.remove();
    open.modal.release();
  }
}

/** Create the App's RemoteSessions and register it (see RemoteSessions.install). */
export function installRemoteSessions(app: RemoteApp): RemoteSessions {
  return new RemoteSessions(app).install();
}
