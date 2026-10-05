// @vitest-environment jsdom
/**
 * Auto-update: the 24 h throttle (pure), and the status-bar notice with the
 * Rust updater commands mocked — found / up to date / disabled key /
 * package-manager / manual (release page) / download → unsaved flow →
 * install → restart.
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
  shouldAutoCheck,
  canSelfInstall,
  formatMb,
  CHECK_INTERVAL_MS,
  STARTUP_DELAY_MS,
  PROGRESS_EVENT,
  type UpdateSupport,
  type UpdateInfo,
  type UpdaterHost,
} from '../updater';
import type { AppConfig } from '../types/AppConfig';

const DAY = 24 * 60 * 60 * 1000;

describe('shouldAutoCheck (24 h throttle)', () => {
  const now = 1_800_000_000_000;

  it('checks when never checked before', () => {
    expect(shouldAutoCheck(now, 0, true)).toBe(true);
  });

  it('waits until 24 h have passed', () => {
    expect(CHECK_INTERVAL_MS).toBe(DAY);
    expect(shouldAutoCheck(now, now - 1000, true)).toBe(false);
    expect(shouldAutoCheck(now, now - DAY + 1, true)).toBe(false);
    expect(shouldAutoCheck(now, now - DAY, true)).toBe(true);
    expect(shouldAutoCheck(now, now - 3 * DAY, true)).toBe(true);
  });

  it('never checks when the setting is off', () => {
    expect(shouldAutoCheck(now, 0, false)).toBe(false);
    expect(shouldAutoCheck(now, now - 3 * DAY, false)).toBe(false);
  });

  it('treats a last check in the future (clock moved back) as stale', () => {
    expect(shouldAutoCheck(now, now + DAY, true)).toBe(true);
  });

  it('treats a garbage timestamp as never checked', () => {
    expect(shouldAutoCheck(now, Number.NaN, true)).toBe(true);
    expect(shouldAutoCheck(now, -5, true)).toBe(true);
  });
});

describe('helpers', () => {
  it('installs in place only for the .app bundle and AppImage', () => {
    expect(canSelfInstall('app')).toBe(true);
    expect(canSelfInstall('app-image')).toBe(true);
    expect(canSelfInstall('package-manager')).toBe(false);
    expect(canSelfInstall('manual')).toBe(false);
  });

  it('formats download progress in MB', () => {
    expect(formatMb(0)).toBe('0.0 MB');
    expect(formatMb(3 * 1024 * 1024 + 512 * 1024)).toBe('3.5 MB');
  });
});

// ---------------------------------------------------------------- UI ----

interface Backend {
  support?: Partial<UpdateSupport>;
  update?: Partial<UpdateInfo> | null;
  checkError?: Error;
  downloadError?: Error;
  log: string[];
}

function backend(b: Omit<Backend, 'log'> = {}): Backend {
  const be: Backend = { ...b, log: [] };
  invoke.mockImplementation(async (cmd: string, args?: unknown) => {
    be.log.push(cmd);
    switch (cmd) {
      case 'update_support':
        return { enabled: true, install: 'app', reason: null, ...be.support };
      case 'update_check':
        if (be.checkError) throw be.checkError;
        if (be.update === null) return null;
        return {
          version: '9.9.9',
          notes: null,
          install: 'app',
          reason: null,
          release_url: 'https://github.com/o/r/releases/latest',
          ...be.update,
        };
      case 'update_download':
        listeners.get(PROGRESS_EVENT)?.({ payload: { received: 2 * 1024 * 1024, total: null } });
        if (be.downloadError) throw be.downloadError;
        return undefined;
      case 'update_install':
      case 'update_restart':
        return undefined;
      case 'open_external':
        be.log.push(`open:${(args as { url: string }).url}`);
        return undefined;
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  });
  return be;
}

function makeHost(log: string[] = [], over: Partial<UpdaterHost> = {}): UpdaterHost {
  return {
    config: {
      check_updates_automatically: true,
      last_update_check_ms: 0,
    } as AppConfig,
    saveConfig: vi.fn(),
    resolveUnsaved: vi.fn(async () => (log.push('unsaved'), true)),
    beforeRestart: vi.fn(async () => void log.push('beforeRestart')),
    ...over,
  };
}

const chip = () => document.getElementById('status-update');
const chipText = () => chip()?.querySelector('.status-update-label')?.textContent ?? '';
const buttons = () =>
  [...(chip()?.querySelectorAll<HTMLButtonElement>('.status-update-btn') ?? [])].map(
    (b) => b.textContent,
  );
const click = (label: string) =>
  [...chip()!.querySelectorAll<HTMLButtonElement>('.status-update-btn')]
    .find((b) => b.textContent === label)!
    .click();
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('UpdateManager notice', () => {
  beforeEach(() => {
    invoke.mockReset();
    listeners.clear();
    document.body.innerHTML = `
      <div id="status-bar">
        <span id="status-path"></span>
        <span class="status-spacer"></span>
        <span id="status-words"></span>
      </div>`;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('shows a non-modal chip with Install & Restart / Later when an update exists', async () => {
    backend({ update: { version: '1.2.3' } });
    const host = makeHost();
    await new UpdateManager(host).check(false);

    expect(chip()?.classList.contains('hidden')).toBe(false);
    expect(chipText()).toBe('Update 1.2.3 available');
    expect(buttons()).toEqual(['Install & Restart', 'Later']);
    // Sits in the status bar before the counters.
    expect(chip()?.nextElementSibling?.id).toBe('status-words');
    // The check is stamped for the 24 h throttle and persisted.
    expect(host.config.last_update_check_ms).toBeGreaterThan(0);
    expect(host.saveConfig).toHaveBeenCalled();
  });

  it('Later hides the chip; a manual check shows it again without refetching', async () => {
    const be = backend();
    const mgr = new UpdateManager(makeHost());
    await mgr.check(false);
    click('Later');
    expect(chip()?.classList.contains('hidden')).toBe(true);

    await mgr.check(true);
    expect(chip()?.classList.contains('hidden')).toBe(false);
    expect(be.log.filter((c) => c === 'update_check')).toHaveLength(1);
  });

  it('stays silent on an automatic check with no update, reports it on a manual one', async () => {
    backend({ update: null });
    await new UpdateManager(makeHost()).check(false);
    expect(chip()).toBeNull();

    await new UpdateManager(makeHost()).check(true);
    expect(chipText()).toBe('SparkDown is up to date.');
  });

  it('skips the check (no network) when the public key is a placeholder', async () => {
    const be = backend({ support: { enabled: false, reason: 'placeholder key' } });
    const host = makeHost();
    await new UpdateManager(host).check(false);
    expect(be.log).toEqual(['update_support']);
    expect(chip()).toBeNull();
    expect(console.warn).toHaveBeenCalled();
    expect(host.config.last_update_check_ms).toBe(0);

    await new UpdateManager(host).check(true);
    expect(chipText()).toBe('Updates are not available for this build.');
  });

  it('swallows a failed automatic check and reports a failed manual one', async () => {
    backend({ checkError: new Error('curl: (22) 404') });
    await new UpdateManager(makeHost()).check(false);
    expect(chip()).toBeNull();

    await new UpdateManager(makeHost()).check(true);
    expect(chipText()).toBe("Couldn't check for updates.");
  });

  it('points .deb / AUR installs at the package manager, with no install button', async () => {
    backend({ update: { version: '2.0.0', install: 'package-manager' } });
    await new UpdateManager(makeHost()).check(false);
    expect(chipText()).toBe('Update 2.0.0 available — update via your package manager');
    expect(buttons()).toEqual(['Dismiss']);
  });

  it('offers the release page when this install cannot update itself', async () => {
    const be = backend({
      update: { version: '2.1.0', install: 'manual', reason: 'cannot write to /Applications' },
    });
    await new UpdateManager(makeHost()).check(false);
    expect(chipText()).toBe('Update 2.1.0 available');
    expect(buttons()).toEqual(['Download', 'Later']);
    expect(chip()?.title).toContain('/Applications');
    click('Download');
    await flush();
    expect(be.log).toContain('open:https://github.com/o/r/releases/latest');
    expect(be.log).not.toContain('update_download');
  });

  it('downloads with progress, runs the unsaved flow, installs, then restarts', async () => {
    const be = backend();
    const host = makeHost(be.log);
    const mgr = new UpdateManager(host);
    await mgr.check(false);
    await mgr.installAndRestart();

    expect(be.log).toEqual([
      'update_support',
      'update_check',
      'update_download',
      'unsaved',
      'update_install',
      'beforeRestart',
      'update_restart',
    ]);
    expect(listeners.has(PROGRESS_EVENT)).toBe(false); // unsubscribed
  });

  it('shows download progress in the chip', async () => {
    backend();
    let seen = '';
    const mgr = new UpdateManager(
      makeHost([], {
        resolveUnsaved: vi.fn(async () => {
          seen = chipText();
          return false;
        }),
      }),
    );
    await mgr.check(false);
    await mgr.installAndRestart();
    expect(seen).toBe('Downloading 9.9.9… 2.0 MB');
  });

  it('aborts the restart (nothing installed) when the unsaved prompt is cancelled', async () => {
    const be = backend({ update: { version: '3.0.0' } });
    const host = makeHost(be.log, { resolveUnsaved: vi.fn(async () => false) });
    const mgr = new UpdateManager(host);
    await mgr.check(false);
    await mgr.installAndRestart();

    expect(be.log).not.toContain('update_install');
    expect(be.log).not.toContain('update_restart');
    expect(host.beforeRestart).not.toHaveBeenCalled();
    expect(chipText()).toBe('Update 3.0.0 is ready');
    expect(buttons()).toEqual(['Restart', 'Later']);

    // Restart later reuses the verified download.
    (host.resolveUnsaved as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    click('Restart');
    await flush();
    await flush();
    expect(be.log.filter((c) => c === 'update_download')).toHaveLength(1);
    expect(be.log).toContain('update_install');
    expect(be.log).toContain('update_restart');
  });

  it('shows the failure with Retry when download or signature check fails', async () => {
    const be = backend({ downloadError: new Error('update signature verification failed') });
    const host = makeHost(be.log);
    const mgr = new UpdateManager(host);
    await mgr.check(false);
    await mgr.installAndRestart();

    expect(chipText()).toBe('Update failed: update signature verification failed');
    expect(buttons()).toEqual(['Retry', 'Dismiss']);
    expect(host.resolveUnsaved).not.toHaveBeenCalled();
    expect(be.log).not.toContain('update_install');
  });

  it('runs the startup check after the delay, and only when the throttle allows', async () => {
    vi.useFakeTimers();
    backend({ update: null });

    const recent = makeHost();
    recent.config.last_update_check_ms = Date.now() - 1000;
    new UpdateManager(recent).scheduleStartupCheck();
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    expect(invoke).not.toHaveBeenCalled();

    const stale = makeHost();
    new UpdateManager(stale).scheduleStartupCheck();
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS - 1);
    expect(invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(invoke).toHaveBeenCalledWith('update_support');

    invoke.mockClear();
    const off = makeHost();
    off.config.check_updates_automatically = false;
    new UpdateManager(off).scheduleStartupCheck();
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    expect(invoke).not.toHaveBeenCalled();
  });
});
