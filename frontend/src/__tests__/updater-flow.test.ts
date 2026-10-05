// @vitest-environment jsdom
/**
 * Auto-update chip, end to end through its states with the Rust commands
 * mocked and each slow step (download, unsaved prompt, install) held open so
 * the chip can be read mid-step:
 * check → available → downloading (with %) → unsaved prompt → installing →
 * restart, plus the cancel / Later / failure / retry paths.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Handler = (e: { payload: unknown }) => void;
const invoke = vi.fn();
const listeners = new Map<string, Handler>();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, h: Handler) => {
    listeners.set(event, h);
    return () => listeners.delete(event);
  }),
}));

import {
  UpdateManager,
  formatProgress,
  PROGRESS_EVENT,
  type DownloadProgress,
  type UpdaterHost,
} from '../updater';
import type { AppConfig } from '../types/AppConfig';

const MB = 1024 * 1024;

describe('formatProgress', () => {
  it('shows a whole percentage when the size is known', () => {
    expect(formatProgress({ received: 0, total: 1000 })).toBe('0%');
    expect(formatProgress({ received: 499, total: 1000 })).toBe('49%');
    expect(formatProgress({ received: 999, total: 1000 })).toBe('99%');
    expect(formatProgress({ received: 1000, total: 1000 })).toBe('100%');
  });

  it('never shows more than 100%', () => {
    expect(formatProgress({ received: 5000, total: 1000 })).toBe('100%');
  });

  it('falls back to MB when the manifest has no size', () => {
    expect(formatProgress({ received: 3 * MB + MB / 2, total: null })).toBe('3.5 MB');
    expect(formatProgress({ received: 2 * MB, total: 0 })).toBe('2.0 MB');
  });
});

// ---------------------------------------------------------------- flow ----

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Mocked backend whose download / install calls wait for the test. */
class Backend {
  log: string[] = [];
  downloads: Deferred<void>[] = [];
  installs: Deferred<void>[] = [];
  restartError: Error | null = null;

  constructor() {
    invoke.mockImplementation(async (cmd: string) => {
      this.log.push(cmd);
      switch (cmd) {
        case 'update_support':
          return { enabled: true, install: 'app', reason: null };
        case 'update_check':
          return {
            version: '9.9.9',
            notes: null,
            install: 'app',
            reason: null,
            release_url: 'https://github.com/o/r/releases/latest',
          };
        case 'update_download': {
          const d = deferred();
          this.downloads.push(d);
          return d.promise;
        }
        case 'update_install': {
          const d = deferred();
          this.installs.push(d);
          return d.promise;
        }
        case 'update_restart':
          if (this.restartError) throw this.restartError;
          return undefined;
        default:
          throw new Error(`unexpected command ${cmd}`);
      }
    });
  }

  progress(p: DownloadProgress): void {
    const h = listeners.get(PROGRESS_EVENT);
    if (!h) throw new Error('no progress listener');
    h({ payload: p });
  }

  count(cmd: string): number {
    return this.log.filter((c) => c === cmd).length;
  }
}

/** Host whose unsaved-changes prompt waits for the test to answer. */
function makeHost(log: string[]) {
  const prompts: Deferred<boolean>[] = [];
  const host: UpdaterHost = {
    config: { check_updates_automatically: true, last_update_check_ms: 0 } as AppConfig,
    saveConfig: vi.fn(),
    resolveUnsaved: vi.fn(() => {
      log.push('unsaved');
      const d = deferred<boolean>();
      prompts.push(d);
      return d.promise;
    }),
    beforeRestart: vi.fn(async () => void log.push('beforeRestart')),
  };
  return { host, prompts };
}

const chip = () => document.getElementById('status-update');
const chipText = () => chip()?.querySelector('.status-update-label')?.textContent ?? '';
const hidden = () => chip()?.classList.contains('hidden') ?? true;
const buttons = () =>
  [...(chip()?.querySelectorAll<HTMLButtonElement>('.status-update-btn') ?? [])].map(
    (b) => b.textContent,
  );
const click = (label: string) => {
  const btn = [...(chip()?.querySelectorAll<HTMLButtonElement>('.status-update-btn') ?? [])].find(
    (b) => b.textContent === label,
  );
  if (!btn) throw new Error(`no "${label}" button; have ${buttons().join(', ')}`);
  btn.click();
};
/** Let pending promise callbacks run. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('UpdateManager chip, end to end', () => {
  let be: Backend;

  beforeEach(() => {
    invoke.mockReset();
    listeners.clear();
    document.body.innerHTML = `
      <div id="status-bar">
        <span id="status-path"></span>
        <span id="status-words"></span>
      </div>`;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    be = new Backend();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fills the status bar slot from index.html (right side, before the counts)', async () => {
    document.body.innerHTML = `
      <div id="status-bar">
        <span id="status-path"></span>
        <span class="status-spacer"></span>
        <span id="status-update" class="status-update hidden"></span>
        <span id="status-words"></span>
      </div>`;
    const slot = document.getElementById('status-update');
    const { host } = makeHost(be.log);
    await new UpdateManager(host).check(false);
    expect(chip()).toBe(slot);
    expect(document.querySelectorAll('#status-update').length).toBe(1);
    expect(slot!.nextElementSibling?.id).toBe('status-words');
    expect(hidden()).toBe(false);
    expect(chipText()).toBe('Update 9.9.9 available');
  });

  it('check → available → downloading % → unsaved → installing → restart', async () => {
    const { host, prompts } = makeHost(be.log);
    const mgr = new UpdateManager(host);

    await mgr.check(false);
    expect(chipText()).toBe('Update 9.9.9 available');
    expect(buttons()).toEqual(['Install & Restart', 'Later']);

    click('Install & Restart');
    await settle();
    // Downloading: no buttons, label follows the progress events.
    expect(chipText()).toBe('Downloading 9.9.9…');
    expect(buttons()).toEqual([]);
    be.progress({ received: 0, total: 40 * MB });
    expect(chipText()).toBe('Downloading 9.9.9… 0%');
    be.progress({ received: 10 * MB, total: 40 * MB });
    expect(chipText()).toBe('Downloading 9.9.9… 25%');
    be.progress({ received: 40 * MB, total: 40 * MB });
    expect(chipText()).toBe('Downloading 9.9.9… 100%');

    // A second click while busy starts nothing.
    await mgr.installAndRestart();
    expect(be.count('update_download')).toBe(1);

    be.downloads[0].resolve();
    await settle();
    expect(listeners.has(PROGRESS_EVENT)).toBe(false);
    // Waiting for the unsaved-changes flow: nothing installed yet.
    expect(prompts).toHaveLength(1);
    expect(be.count('update_install')).toBe(0);

    prompts[0].resolve(true);
    await settle();
    expect(chipText()).toBe('Installing 9.9.9…');
    expect(buttons()).toEqual([]);
    expect(host.beforeRestart).not.toHaveBeenCalled();

    be.installs[0].resolve();
    await settle();
    expect(be.log).toEqual([
      'update_support',
      'update_check',
      'update_download',
      'unsaved',
      'update_install',
      'beforeRestart',
      'update_restart',
    ]);
  });

  it('shows MB received when the manifest has no size', async () => {
    const { host } = makeHost(be.log);
    const mgr = new UpdateManager(host);
    await mgr.check(false);
    click('Install & Restart');
    await settle();
    be.progress({ received: 1.5 * MB, total: null });
    expect(chipText()).toBe('Downloading 9.9.9… 1.5 MB');
    be.downloads[0].resolve();
    await settle();
  });

  it('Later on the available chip hides it and downloads nothing', async () => {
    const { host } = makeHost(be.log);
    const mgr = new UpdateManager(host);
    await mgr.check(false);
    click('Later');
    expect(hidden()).toBe(true);
    await settle();
    expect(be.count('update_download')).toBe(0);
  });

  it('cancel at the unsaved prompt keeps the download; Restart later reuses it', async () => {
    const { host, prompts } = makeHost(be.log);
    const mgr = new UpdateManager(host);
    await mgr.check(false);
    click('Install & Restart');
    await settle();
    be.downloads[0].resolve();
    await settle();

    prompts[0].resolve(false);
    await settle();
    expect(chipText()).toBe('Update 9.9.9 is ready');
    expect(buttons()).toEqual(['Restart', 'Later']);
    expect(be.count('update_install')).toBe(0);
    expect(host.beforeRestart).not.toHaveBeenCalled();

    // Later, then a manual check brings the chip back without refetching.
    click('Later');
    expect(hidden()).toBe(true);
    await mgr.check(true);
    expect(hidden()).toBe(false);
    expect(be.count('update_check')).toBe(1);

    click('Install & Restart');
    await settle();
    expect(be.count('update_download')).toBe(1); // verified download reused
    prompts[1].resolve(true);
    await settle();
    be.installs[0].resolve();
    await settle();
    expect(be.log.slice(-3)).toEqual(['update_install', 'beforeRestart', 'update_restart']);
  });

  it('a second cancel keeps the ready state', async () => {
    const { host, prompts } = makeHost(be.log);
    const mgr = new UpdateManager(host);
    await mgr.check(false);
    click('Install & Restart');
    await settle();
    be.downloads[0].resolve();
    await settle();
    prompts[0].resolve(false);
    await settle();
    click('Restart');
    await settle();
    prompts[1].resolve(false);
    await settle();
    expect(chipText()).toBe('Update 9.9.9 is ready');
    expect(be.count('update_download')).toBe(1);
    expect(be.count('update_install')).toBe(0);
  });

  it('a failed download (e.g. size mismatch) offers Retry, which downloads again', async () => {
    const { host, prompts } = makeHost(be.log);
    const mgr = new UpdateManager(host);
    await mgr.check(false);
    click('Install & Restart');
    await settle();
    be.progress({ received: 5 * MB, total: 10 * MB });
    be.downloads[0].reject(new Error('the update is 5 bytes, but the manifest says 10'));
    await settle();
    expect(chipText()).toBe('Update failed: the update is 5 bytes, but the manifest says 10');
    expect(buttons()).toEqual(['Retry', 'Dismiss']);
    expect(host.resolveUnsaved).not.toHaveBeenCalled();
    expect(listeners.has(PROGRESS_EVENT)).toBe(false);

    click('Retry');
    await settle();
    expect(chipText()).toBe('Downloading 9.9.9…');
    be.downloads[1].resolve();
    await settle();
    prompts[0].resolve(true);
    await settle();
    be.installs[0].resolve();
    await settle();
    expect(be.count('update_download')).toBe(2);
    expect(be.log[be.log.length - 1]).toBe('update_restart');
  });

  it('a failed install needs a fresh download on Retry', async () => {
    const { host, prompts } = makeHost(be.log);
    const mgr = new UpdateManager(host);
    await mgr.check(false);
    click('Install & Restart');
    await settle();
    be.downloads[0].resolve();
    await settle();
    prompts[0].resolve(true);
    await settle();
    be.installs[0].reject(new Error('extracting the update failed'));
    await settle();
    expect(chipText()).toBe('Update failed: extracting the update failed');
    expect(host.beforeRestart).not.toHaveBeenCalled();
    expect(be.count('update_restart')).toBe(0);

    click('Retry');
    await settle();
    expect(be.count('update_download')).toBe(2);
  });

  it('Dismiss after a failure hides the chip', async () => {
    const { host } = makeHost(be.log);
    const mgr = new UpdateManager(host);
    await mgr.check(false);
    click('Install & Restart');
    await settle();
    be.downloads[0].reject(new Error('update signature verification failed'));
    await settle();
    click('Dismiss');
    expect(hidden()).toBe(true);
  });

  it('a failed relaunch is reported', async () => {
    be.restartError = new Error('cannot relaunch: denied');
    const { host, prompts } = makeHost(be.log);
    const mgr = new UpdateManager(host);
    await mgr.check(false);
    click('Install & Restart');
    await settle();
    be.downloads[0].resolve();
    await settle();
    prompts[0].resolve(true);
    await settle();
    be.installs[0].resolve();
    await settle();
    expect(host.beforeRestart).toHaveBeenCalled();
    expect(chipText()).toBe('Update failed: cannot relaunch: denied');
    expect(buttons()).toEqual(['Retry', 'Dismiss']);
  });
});
