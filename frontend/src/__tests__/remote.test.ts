// @vitest-environment jsdom
/**
 * Remote sessions v1 (#36): dialog + the one-workspace folder-open handler
 * App.openFolder routes through. Backend SSH is mocked at invoke().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => {
  throw new Error(`unmocked ${_args[0]}`);
});
const dialogMessage = vi.fn(async (..._args: unknown[]): Promise<void> => {});
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  message: (...args: unknown[]) => dialogMessage(...args),
}));

import { api } from '../api';
import {
  formatRemoteRecent,
  installRemoteSessions,
  isValidTypedHost,
  isRemoteRecent,
  keyTypeLabel,
  parseRemoteError,
  parseRemoteRecent,
  passwordOnlyMessage,
  RemoteSessions,
  type RemoteApp,
  type RemoteHandler,
} from '../remote';

const HOSTS = [
  {
    alias: 'dev',
    hostname: '10.0.0.5',
    user: 'ubuntu',
    port: 22,
    identity_file: '~/.ssh/dev',
    password_only: false,
  },
  {
    alias: 'passwordbox',
    hostname: '10.0.0.9',
    user: null,
    port: null,
    identity_file: null,
    password_only: true,
  },
];

function mountShell(): void {
  document.body.innerHTML = `
    <div id="welcome-actions">
      <button class="welcome-btn welcome-btn-primary" data-welcome="open-folder">Open Folder…</button>
      <button class="welcome-btn" data-welcome="open-file">Open File…</button>
    </div>
    <div id="status-bar">
      <span id="status-path">No file open</span>
      <span class="status-spacer"></span>
    </div>`;
}

/** Click the host chip and pick `label` from its menu. */
function pickChipMenu(label: string): void {
  document.getElementById('status-remote')!.click();
  const item = [...document.querySelectorAll<HTMLElement>('.sd-ctxmenu-item')].find(
    (el) => el.textContent === label,
  );
  if (!item) throw new Error(`no chip menu item "${label}"`);
  item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
}

describe('remote recent encoding', () => {
  it('round-trips host + absolute path', () => {
    const encoded = formatRemoteRecent('dev', '/home/u/proj');
    expect(encoded).toBe('ssh://dev/home/u/proj');
    expect(parseRemoteRecent(encoded)).toEqual({ host: 'dev', path: '/home/u/proj' });
    expect(isRemoteRecent(encoded)).toBe(true);
    expect(isRemoteRecent('/Users/p/local')).toBe(false);
    expect(parseRemoteRecent('/Users/p/local')).toBeNull();
  });

  it('normalizes a path missing a leading slash', () => {
    expect(formatRemoteRecent('box', 'var/src')).toBe('ssh://box/var/src');
    expect(parseRemoteRecent('ssh://box/var/src')).toEqual({ host: 'box', path: '/var/src' });
  });
});

describe('remote sessions UI', () => {
  let opened: string[];
  let pathBases: Array<string | null>;
  let remembered: string[];
  /** Ordered log of origin-switch hooks, interleaved with backend calls. */
  let switches: string[];
  let allowSwitch: boolean;
  let app: RemoteApp;
  /** What installRemoteSessions registered via app.setRemoteHandler. */
  let handler: RemoteHandler | null;

  beforeEach(() => {
    opened = [];
    pathBases = [];
    remembered = [];
    switches = [];
    allowSwitch = true;
    handler = null;
    // Mirrors App: openFolder routes through the registered handler, whose
    // openResolved is the real workspace open; this App is already ready,
    // so the handler attaches at once.
    const openResolved = async (dir: string) => { opened.push(dir); };
    app = {
      setRemoteHandler: (h: RemoteHandler) => {
        handler = h;
        h.attach();
      },
      openFolder: (dir: string) =>
        handler ? handler.openFolder(dir, openResolved) : openResolved(dir),
      setRemotePathBase: (base: string | null) => { pathBases.push(base); },
      rememberRecentFolder: (entry: string) => { remembered.push(entry); },
      prepareOriginSwitch: async (target: string | null) => {
        switches.push(`prepare:${target}`);
        return allowSwitch;
      },
      commitOriginSwitch: (target: string | null) => { switches.push(`commit:${target}`); },
      cancelOriginSwitch: () => { switches.push('cancel'); },
    };
    invoke.mockReset();
    dialogMessage.mockReset();
    invoke.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      const extra = args[1] as Record<string, unknown> | undefined;
      switch (cmd) {
        case 'ssh_config_hosts':
          return HOSTS;
        case 'remote_connect':
          return { host: extra?.host, path: '/home/u/proj' };
        case 'remote_disconnect':
          return;
        case 'remote_session':
          return null;
        default:
          throw new Error(`unmocked ${cmd}`);
      }
    });
    mountShell();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.querySelectorAll('.remote-overlay').forEach((n) => n.remove());
  });

  it('registers a folder-open handler instead of replacing app.openFolder', async () => {
    const openFolder = app.openFolder;
    installRemoteSessions(app);
    expect(app.openFolder).toBe(openFolder);
    expect(handler).not.toBeNull();
    // A local path with no session goes straight to the workspace open.
    await app.openFolder('/local/code');
    expect(opened).toEqual(['/local/code']);
  });

  it('injects a welcome button and status chip', () => {
    installRemoteSessions(app);
    const btn = document.getElementById('welcome-open-remote');
    expect(btn).toBeTruthy();
    expect(btn?.textContent).toContain('Remote');
    expect(document.getElementById('status-remote')).toBeTruthy();
  });

  it('connect opens the remote path as the workspace', async () => {
    const session = await new RemoteSessions(app).connect('dev', '~/proj', app.openFolder);
    expect(session.path).toBe('/home/u/proj');
    expect(opened).toEqual(['/home/u/proj']);
    expect(invoke).toHaveBeenCalledWith('remote_connect', { host: 'dev', path: '~/proj' });
  });

  it('the handler remembers ssh://host/path after a remote connect', async () => {
    let session: { host: string; path: string } | null = null;
    invoke.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      const extra = args[1] as Record<string, unknown> | undefined;
      if (cmd === 'ssh_config_hosts') return HOSTS;
      if (cmd === 'remote_connect') {
        session = { host: String(extra?.host), path: '/home/u/proj' };
        return session;
      }
      if (cmd === 'remote_session') return session;
      if (cmd === 'remote_disconnect') {
        session = null;
        return;
      }
      throw new Error(cmd);
    });
    const remote = installRemoteSessions(app);
    await remote.connect('dev', '~/proj', app.openFolder);
    expect(opened).toEqual(['/home/u/proj']);
    expect(remembered).toContain('ssh://dev/home/u/proj');
  });

  it('clicking a recent remote entry reconnects and opens the path', async () => {
    let session: { host: string; path: string } | null = null;
    invoke.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      const extra = args[1] as Record<string, unknown> | undefined;
      if (cmd === 'remote_connect') {
        session = { host: String(extra?.host), path: '/home/u/proj' };
        return session;
      }
      if (cmd === 'remote_session') return session;
      if (cmd === 'remote_disconnect') {
        session = null;
        return;
      }
      if (cmd === 'ssh_config_hosts') return HOSTS;
      throw new Error(cmd);
    });
    installRemoteSessions(app);
    await app.openFolder('ssh://dev/home/u/proj');
    expect(invoke.mock.calls.some((c) => c[0] === 'remote_connect')).toBe(true);
    expect(opened).toEqual(['/home/u/proj']);
    expect(pathBases).toContain('/home/u/proj');
    expect(remembered[remembered.length - 1]).toBe('ssh://dev/home/u/proj');
  });

  it('reuses an existing session for the same host+path without reconnecting', async () => {
    const session = { host: 'dev', path: '/home/u/proj' };
    invoke.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'remote_session') return session;
      if (cmd === 'remote_connect') throw new Error('should not reconnect');
      if (cmd === 'remote_disconnect') throw new Error('should not disconnect');
      throw new Error(cmd);
    });
    installRemoteSessions(app);
    await app.openFolder('ssh://dev/home/u/proj');
    expect(opened).toEqual(['/home/u/proj']);
    expect(invoke.mock.calls.some((c) => c[0] === 'remote_connect')).toBe(false);
  });

  it('shows an error dialog when recent remote reconnect fails', async () => {
    invoke.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'remote_session') return null;
      if (cmd === 'remote_connect') {
        throw "Host 'dev' is unreachable. Connection timed out";
      }
      throw new Error(cmd);
    });
    installRemoteSessions(app);
    await app.openFolder('ssh://dev/home/u/proj');
    expect(opened).toEqual([]);
    expect(dialogMessage).toHaveBeenCalled();
    const msg = String(dialogMessage.mock.calls[0]?.[0] ?? '');
    expect(msg).toContain('unreachable');
    expect(msg).toContain('dev');
  });

  it('password-only hosts fail clearly without connecting', async () => {
    const remote = installRemoteSessions(app);
    await remote.openDialog();
    const select = document.getElementById('remote-host') as HTMLSelectElement;
    select.value = 'passwordbox';
    const go = document.querySelector('.remote-btn-primary') as HTMLButtonElement;
    go.click();
    await vi.waitFor(() => {
      const err = document.querySelector('.remote-error') as HTMLElement;
      expect(err.classList.contains('hidden')).toBe(false);
      expect(err.textContent).toContain('password');
    });
    expect(opened).toEqual([]);
    expect(invoke.mock.calls.some((c) => c[0] === 'remote_connect')).toBe(false);
  });

  it('a typed user@host:port connects without a ~/.ssh/config entry (#22)', async () => {
    let connected: unknown = null;
    invoke.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'ssh_config_hosts') return [];
      if (cmd === 'remote_session') return connected;
      if (cmd === 'remote_connect') {
        const a = args[1] as { host: string; path: string };
        connected = { host: a.host, path: '/home/me' };
        return connected;
      }
      return null;
    });
    const remote = installRemoteSessions(app);
    await remote.openDialog();
    const go = document.querySelector('.remote-btn-primary') as HTMLButtonElement;
    const typed = document.getElementById('remote-host-typed') as HTMLInputElement;
    expect(go.disabled).toBe(true);
    typed.value = 'me@127.0.0.1:2222';
    typed.dispatchEvent(new Event('input'));
    expect(go.disabled).toBe(false);
    go.click();
    await vi.waitFor(() => {
      const call = invoke.mock.calls.find((c) => c[0] === 'remote_connect');
      expect(call?.[1]).toMatchObject({ host: 'me@127.0.0.1:2222' });
    });
  });

  it('a malformed typed host is refused before calling the backend', async () => {
    const remote = installRemoteSessions(app);
    await remote.openDialog();
    const typed = document.getElementById('remote-host-typed') as HTMLInputElement;
    typed.value = '-oProxyCommand=sh';
    typed.dispatchEvent(new Event('input'));
    (document.querySelector('.remote-btn-primary') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      const err = document.querySelector('.remote-error') as HTMLElement;
      expect(err.textContent).toContain('not a valid host');
    });
    expect(invoke.mock.calls.some((c) => c[0] === 'remote_connect')).toBe(false);
  });

  it('isValidTypedHost mirrors the backend parser', () => {
    for (const ok of ['localhost', 'me@host', 'me@127.0.0.1:2222', 'host:22', 'me@[::1]:2200', '[fe80::1]', 'dev_box.lan']) {
      expect(isValidTypedHost(ok), ok).toBe(true);
    }
    for (const bad of ['', '-G', '-oProxyCommand=sh', 'me@-x', 'ho st', 'host;id', '$(id)', '`id`', 'a@b@c',
      '@host', 'me@', 'host:', 'host:0', 'host:65536', 'host:22:33', '::1', '[::1', '.hidden', 'host/x', 'host\n']) {
      expect(isValidTypedHost(bad), bad).toBe(false);
    }
  });

  it('unreachable / backend errors surface in the dialog', async () => {
    invoke.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'ssh_config_hosts') return HOSTS;
      if (cmd === 'remote_session') return null;
      if (cmd === 'remote_connect') {
        throw "Host 'dev' is unreachable. Connection timed out";
      }
      throw new Error(cmd);
    });
    const remote = installRemoteSessions(app);
    await remote.openDialog();
    const go = document.querySelector('.remote-btn-primary') as HTMLButtonElement;
    go.click();
    await vi.waitFor(() => {
      const err = document.querySelector('.remote-error') as HTMLElement;
      expect(err.textContent).toContain('unreachable');
    });
    expect(opened).toEqual([]);
  });

  describe('first connect and key errors (#24, #25)', () => {
    const SCAN = {
      scan_id: 'scan-1',
      known_hosts_name: '[127.0.0.1]:2222',
      keys: [{ key_type: 'ssh-ed25519', fingerprint: 'SHA256:abcDEF123' }],
      known_hosts_file: '/home/u/.ssh/known_hosts',
      hashed: true,
    };
    let connectCalls: number;
    let firstError: string;
    function mock(): void {
      connectCalls = 0;
      invoke.mockImplementation(async (...args: unknown[]) => {
        const cmd = args[0] as string;
        switch (cmd) {
          case 'ssh_config_hosts':
            return HOSTS;
          case 'remote_session':
            return null;
          case 'remote_connect':
            connectCalls += 1;
            if (connectCalls === 1) throw firstError;
            return { host: 'dev', path: '/home/u/proj' };
          case 'remote_hostkey_scan':
            return SCAN;
          case 'remote_hostkey_trust':
          case 'remote_hostkey_forget':
            return null;
          default:
            throw new Error(`unmocked ${cmd}`);
        }
      });
    }
    const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);
    async function start(): Promise<void> {
      const remote = installRemoteSessions(app);
      await remote.openDialog();
      (document.querySelector('.remote-btn-primary') as HTMLButtonElement).click();
    }

    it('an unknown host key shows the fingerprints and connects only after Trust', async () => {
      firstError = "[hostkey-unknown] 'dev' is not in your known_hosts yet.";
      mock();
      await start();
      await vi.waitFor(() => expect(document.querySelector('.remote-hostkey')).not.toBeNull());
      const panel = document.querySelector('.remote-hostkey') as HTMLElement;
      expect(panel.textContent).toContain('[127.0.0.1]:2222');
      expect(panel.textContent).toContain('ED25519');
      expect(panel.textContent).toContain('SHA256:abcDEF123');
      expect(panel.textContent).toContain('(hashed)');
      // Nothing is trusted or retried before the click.
      expect(calls('remote_hostkey_trust')).toHaveLength(0);
      expect(connectCalls).toBe(1);
      (document.getElementById('remote-hostkey-trust') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(opened).toEqual(['/home/u/proj']));
      expect(calls('remote_hostkey_trust')[0][1]).toEqual({ scanId: 'scan-1' });
      expect(connectCalls).toBe(2);
    });

    it("Don't trust leaves known_hosts alone and does not connect", async () => {
      firstError = "[hostkey-unknown] 'dev' is not in your known_hosts yet.";
      mock();
      await start();
      await vi.waitFor(() => expect(document.querySelector('.remote-hostkey')).not.toBeNull());
      const no = [...document.querySelectorAll<HTMLButtonElement>('.remote-hostkey .remote-btn')].find(
        (b) => b.textContent === "Don't trust",
      )!;
      no.click();
      await vi.waitFor(() => {
        const err = document.querySelector('.remote-error') as HTMLElement;
        expect(err.textContent).toContain('not trusted');
      });
      expect(calls('remote_hostkey_trust')).toHaveLength(0);
      expect(calls('remote_hostkey_forget')[0][1]).toEqual({ scanId: 'scan-1' });
      expect(connectCalls).toBe(1);
      expect(opened).toEqual([]);
    });

    it('a changed host key is a hard stop: no scan, no accept button', async () => {
      firstError = "[hostkey-changed] WARNING: the host key for 'dev' has CHANGED since you last connected.";
      mock();
      await start();
      await vi.waitFor(() => {
        const err = document.querySelector('.remote-error') as HTMLElement;
        expect(err.textContent).toContain('CHANGED');
        expect(err.classList.contains('remote-error-danger')).toBe(true);
        expect(err.textContent).not.toContain('[hostkey-changed]');
      });
      expect(calls('remote_hostkey_scan')).toHaveLength(0);
      expect(document.querySelector('.remote-hostkey')).toBeNull();
    });

    it('a passphrase key without an agent explains ssh-add and links the docs', async () => {
      const url = 'https://github.com/sparkdown/sparkdown/blob/main/docs/remote-ssh.md#passphrase-protected-keys';
      firstError = `[key-needs-agent] Your key needs an SSH agent: run ssh-add and relaunch SparkDown. (Key: ~/.ssh/id_ed25519) See ${url}`;
      mock();
      await start();
      await vi.waitFor(() => {
        const err = document.querySelector('.remote-error') as HTMLElement;
        expect(err.textContent).toContain('run ssh-add and relaunch SparkDown');
        expect(err.querySelector('a')?.getAttribute('href')).toBe(url);
      });
    });
  });

  it('parseRemoteError splits code, text and docs link', () => {
    expect(parseRemoteError("Host 'x' is unreachable.")).toEqual({
      code: null,
      text: "Host 'x' is unreachable.",
      link: null,
    });
    const p = parseRemoteError(
      '[key-needs-agent] Run ssh-add. See https://github.com/sparkdown/sparkdown/blob/main/docs/remote-ssh.md#x',
    );
    expect(p.code).toBe('key-needs-agent');
    expect(p.text).toBe('Run ssh-add.');
    expect(p.link).toContain('docs/remote-ssh.md#x');
    // Links elsewhere are never turned into clickable links.
    expect(parseRemoteError('[hostkey-changed] See https://evil.example/x').link).toBeNull();
    expect(keyTypeLabel('ssh-ed25519')).toBe('ED25519');
    expect(keyTypeLabel('ecdsa-sha2-nistp256')).toBe('ECDSA');
    expect(keyTypeLabel('ssh-rsa')).toBe('RSA');
  });

  it('one workspace at a time: opening a local folder disconnects remote', async () => {
    let session: { host: string; path: string } | null = {
      host: 'dev',
      path: '/home/u/proj',
    };
    invoke.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'remote_session') return session;
      if (cmd === 'remote_disconnect') {
        session = null;
        return;
      }
      if (cmd === 'ssh_config_hosts') return HOSTS;
      throw new Error(cmd);
    });
    installRemoteSessions(app);
    await app.openFolder('/local/code');
    expect(session).toBeNull();
    expect(opened).toEqual(['/local/code']);
    expect(invoke.mock.calls.some((c) => c[0] === 'remote_disconnect')).toBe(true);
  });

  it('one workspace at a time: reconnecting to the same path does not disconnect', async () => {
    const session = { host: 'dev', path: '/home/u/proj' };
    invoke.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'remote_session') return session;
      if (cmd === 'remote_disconnect') throw new Error('should not disconnect');
      throw new Error(cmd);
    });
    installRemoteSessions(app);
    await app.openFolder('/home/u/proj');
    expect(opened).toEqual(['/home/u/proj']);
    expect(remembered).toContain('ssh://dev/home/u/proj');
  });

  it('git status and watch stay on the existing api commands (SSH is behind them)', () => {
    // Product: Changes still works because git_status / watch_start are the
    // same frontend calls; the Rust transport routes them over SSH.
    expect(typeof api.gitStatus).toBe('function');
    expect(typeof api.watchStart).toBe('function');
    expect(typeof api.sshConfigHosts).toBe('function');
  });

  it('status chip sits after the path, shows the host, and can hide', () => {
    const remote = installRemoteSessions(app);
    remote.renderStatusChip({ host: 'dev', path: '/home/u/proj', home: '/home/u' });
    const chip = document.getElementById('status-remote')!;
    // A shell without the index.html slot gets the chip right after the
    // path. Host only — the path element complements it.
    expect(document.getElementById('status-path')!.nextElementSibling).toBe(chip);
    expect(chip.classList.contains('hidden')).toBe(false);
    expect(chip.querySelector('.status-remote-label')!.textContent).toBe('ssh dev');
    expect(chip.title).toContain('/home/u/proj');
    remote.renderStatusChip(null);
    expect(chip.classList.contains('hidden')).toBe(true);
  });

  it('uses the index.html slot for the chip when there is one', () => {
    document.getElementById('status-path')!.insertAdjacentHTML(
      'afterend',
      '<span id="status-branch"></span><button id="status-remote" class="status-remote hidden"><span class="status-remote-label"></span></button>',
    );
    const slot = document.getElementById('status-remote');
    const remote = installRemoteSessions(app);
    remote.renderStatusChip({ host: 'dev', path: '/home/u/proj', home: '/home/u' });
    expect(document.getElementById('status-remote')).toBe(slot);
    expect(document.querySelectorAll('#status-remote').length).toBe(1);
    expect(slot!.querySelector('.status-remote-label')!.textContent).toBe('ssh dev');
  });

  it('the chip menu offers another remote folder', async () => {
    const remote = installRemoteSessions(app);
    await remote.connect('dev', '~', app.openFolder);
    pickChipMenu('Open Another Remote Folder…');
    await vi.waitFor(() => expect(document.querySelector('.remote-dialog')).not.toBeNull());
  });

  it('the chip menu disconnects and clears the path base', async () => {
    const remote = installRemoteSessions(app);
    await remote.connect('dev', '~', app.openFolder);
    expect(pathBases).toContain('/home/u/proj');

    pickChipMenu('Disconnect');
    await vi.waitFor(() => expect(pathBases[pathBases.length - 1]).toBeNull());

    expect(invoke.mock.calls.some((c) => c[0] === 'remote_disconnect')).toBe(true);
    expect(document.getElementById('status-remote')!.classList.contains('hidden')).toBe(true);
  });

  it('connect resolves tabs before remote_connect and closes them after', async () => {
    const remote = installRemoteSessions(app);
    await Promise.resolve();
    invoke.mockClear();
    await remote.connect('dev', '~/proj', app.openFolder);
    expect(switches).toEqual(['prepare:dev', 'commit:dev']);
    expect(opened).toEqual(['/home/u/proj']);
  });

  it('a failed remote_connect cancels the prepared switch instead of committing it', async () => {
    const remote = installRemoteSessions(app);
    await Promise.resolve();
    invoke.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === 'remote_connect') throw new Error('unreachable');
      if (args[0] === 'remote_session') return null;
      throw new Error(`unmocked ${String(args[0])}`);
    });
    await expect(remote.connect('dev', '~/proj', app.openFolder)).rejects.toThrow('unreachable');
    expect(switches).toEqual(['prepare:dev', 'cancel']);
    expect(opened).toEqual([]);
  });

  it('cancelling the unsaved prompt aborts the connect with no error dialog', async () => {
    installRemoteSessions(app);
    allowSwitch = false;
    await app.openFolder('ssh://dev/home/u/proj');
    expect(invoke.mock.calls.some((c) => c[0] === 'remote_connect')).toBe(false);
    expect(switches).toEqual(['prepare:dev']);
    expect(opened).toEqual([]);
    expect(dialogMessage).not.toHaveBeenCalled();
  });

  it('cancelling the unsaved prompt on disconnect keeps the session and the folder', async () => {
    const session = { host: 'dev', path: '/home/u/proj' };
    invoke.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'remote_session') return session;
      if (cmd === 'remote_disconnect') throw new Error('should not disconnect');
      throw new Error(cmd);
    });
    installRemoteSessions(app);
    await vi.waitFor(() => expect(switches).toEqual(['commit:dev']));
    allowSwitch = false;
    await app.openFolder('/local/code');
    expect(switches).toEqual(['commit:dev', 'prepare:null']);
    expect(opened).toEqual([]);
  });

  it('the chip menu disconnect runs the origin switch to local around it', async () => {
    const remote = installRemoteSessions(app);
    await remote.connect('dev', '~', app.openFolder);
    switches.length = 0;
    pickChipMenu('Disconnect');
    await vi.waitFor(() => expect(switches).toEqual(['prepare:null', 'commit:null']));
    expect(invoke.mock.calls.some((c) => c[0] === 'remote_disconnect')).toBe(true);
  });

  it('passwordOnlyMessage is explicit about keys-only / no prompt', () => {
    const msg = passwordOnlyMessage('box');
    expect(msg).toContain('box');
    expect(msg.toLowerCase()).toContain('password');
    expect(msg.toLowerCase()).toContain('no password prompt');
  });

  it('reopen connects when no session is live', async () => {
    await new RemoteSessions(app).reopen('dev', '/home/u/proj', app.openFolder);
    expect(opened).toEqual(['/home/u/proj']);
    expect(invoke).toHaveBeenCalledWith('remote_connect', { host: 'dev', path: '/home/u/proj' });
  });
});
