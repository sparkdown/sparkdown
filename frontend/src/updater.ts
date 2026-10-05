import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AppConfig } from './types/AppConfig';

/**
 * Auto-update UI. The work happens in Rust (src-tauri/src/updates.rs: system
 * curl + minisign verification). Calm by design: one quiet check shortly
 * after launch, at most once per 24 h, plus the manual "Check for Updates..."
 * menu item. A found update shows a small status-bar chip; nothing downloads
 * until the user clicks Install, and the restart goes through the app's
 * unsaved-changes flow first (a Cancel there aborts the restart).
 */

/** Minimum time between automatic checks. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Delay after launch before the automatic check, so startup stays fast. */
export const STARTUP_DELAY_MS = 10_000;
/** How long "up to date" stays visible after a manual check. */
const INFO_HIDE_MS = 4_000;
/** Mirror of PROGRESS_EVENT in updates.rs (payload: DownloadProgress). */
export const PROGRESS_EVENT = 'update-progress';

/** Mirror of `DownloadProgress` in src-tauri/src/updates.rs. `total` is the
 *  manifest's `size`; older manifests have none (null). */
export interface DownloadProgress {
  received: number;
  total: number | null;
}

/** Mirror of `InstallKind` in src-tauri/src/updates.rs. */
export type InstallKind = 'app' | 'app-image' | 'package-manager' | 'manual';

/** Mirror of `UpdateSupport` in src-tauri/src/updates.rs. */
export interface UpdateSupport {
  enabled: boolean;
  install: InstallKind;
  reason: string | null;
}

/** Mirror of `UpdateInfo` in src-tauri/src/updates.rs. */
export interface UpdateInfo {
  version: string;
  notes: string | null;
  install: InstallKind;
  reason: string | null;
  release_url: string;
}

/**
 * 24 h throttle for the automatic check. `lastCheckMs` 0 means never. A last
 * check in the future (the clock moved back) counts as stale, so a bad clock
 * cannot block checks for a long time.
 */
export function shouldAutoCheck(now: number, lastCheckMs: number, enabled: boolean): boolean {
  if (!enabled) return false;
  if (!Number.isFinite(lastCheckMs) || lastCheckMs <= 0) return true;
  if (lastCheckMs > now) return true;
  return now - lastCheckMs >= CHECK_INTERVAL_MS;
}

/** In-place install works only for the .app bundle and the AppImage. */
export function canSelfInstall(kind: InstallKind): boolean {
  return kind === 'app' || kind === 'app-image';
}

/** "12.3 MB" for the download progress label. */
export function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Progress label: "42%" when the total is known, else the MB received. Floors
 * (100% only when every byte is in) and clamps, so a bad total never shows
 * more than 100%.
 */
export function formatProgress(p: DownloadProgress): string {
  const { received, total } = p;
  if (total && total > 0 && Number.isFinite(total)) {
    const pct = Math.min(100, Math.max(0, Math.floor((received * 100) / total)));
    return `${pct}%`;
  }
  return formatMb(received);
}

export interface UpdaterHost {
  /** Live config; the updater reads the setting and writes the timestamp. */
  config: AppConfig;
  /** Persist config (debounced by the app). */
  saveConfig: () => void;
  /** The app's unsaved-changes flow. false = the user cancelled. */
  resolveUnsaved: () => Promise<boolean>;
  /** Flush state (config, agent context) just before the relaunch. */
  beforeRestart: () => Promise<void>;
}

interface ChipButton {
  label: string;
  onClick: () => void;
}

export class UpdateManager {
  private host: UpdaterHost;
  private chip: HTMLElement | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private update: UpdateInfo | null = null;
  private downloaded = false;

  constructor(host: UpdaterHost) {
    this.host = host;
  }

  /** Schedule the quiet startup check. The throttle is read when it fires,
   *  so a settings change in the first seconds is respected. */
  scheduleStartupCheck(delayMs = STARTUP_DELAY_MS): void {
    setTimeout(() => {
      const cfg = this.host.config;
      if (shouldAutoCheck(Date.now(), cfg.last_update_check_ms ?? 0, cfg.check_updates_automatically ?? true)) {
        void this.check(false);
      }
    }, delayMs);
  }

  /**
   * Check for an update. `manual` (menu item) reports every outcome; the
   * automatic check reports only a found update and logs everything else.
   */
  async check(manual: boolean): Promise<void> {
    if (this.busy) return;
    if (this.update) {
      // Already found (the chip may have been dismissed with Later).
      if (manual) this.showAvailable();
      return;
    }
    this.busy = true;
    if (manual) this.showChip('Checking for updates…', []);
    try {
      const support = await invoke<UpdateSupport>('update_support');
      if (!support.enabled) {
        console.warn(`Update check skipped: ${support.reason ?? 'not supported'}`);
        if (manual) {
          this.showChip('Updates are not available for this build.', [this.dismissButton()]);
        }
        return;
      }
      // Stamp before the network call, so a failing check (offline, repo
      // not public yet) still waits 24 h instead of retrying every launch.
      this.host.config.last_update_check_ms = Date.now();
      this.host.saveConfig();

      const update = await invoke<UpdateInfo | null>('update_check');
      if (!update) {
        if (manual) this.showChip('SparkDown is up to date.', [], INFO_HIDE_MS);
        return;
      }
      this.update = update;
      this.showAvailable();
    } catch (err) {
      console.warn('Update check failed:', err);
      if (manual) this.showChip("Couldn't check for updates.", [this.dismissButton()]);
    } finally {
      this.busy = false;
    }
  }

  /** Download + verify (with progress), then the unsaved-changes flow,
   *  then install and relaunch. */
  async installAndRestart(): Promise<void> {
    const update = this.update;
    if (!update || this.busy) return;
    this.busy = true;
    try {
      if (!this.downloaded) {
        this.showChip(`Downloading ${update.version}…`, []);
        const unlisten = await listen<DownloadProgress>(PROGRESS_EVENT, (e) => {
          this.setLabel(`Downloading ${update.version}… ${formatProgress(e.payload)}`);
        });
        try {
          await invoke('update_download');
        } finally {
          unlisten();
        }
        this.downloaded = true;
      }
      // The download is verified; nothing is replaced on disk until the
      // user has saved or discarded their work.
      const proceed = await this.host.resolveUnsaved();
      if (!proceed) {
        this.showChip(`Update ${update.version} is ready`, [
          { label: 'Restart', onClick: () => void this.installAndRestart() },
          { label: 'Later', onClick: () => this.hide() },
        ]);
        return;
      }
      this.showChip(`Installing ${update.version}…`, []);
      // Install consumes the download: a failure below means download again.
      this.downloaded = false;
      await invoke('update_install');
      await this.host.beforeRestart();
      await invoke('update_restart');
    } catch (err) {
      console.error('Update install failed:', err);
      this.downloaded = false;
      this.showChip(`Update failed: ${errorText(err)}`, [
        { label: 'Retry', onClick: () => void this.installAndRestart() },
        this.dismissButton(),
      ]);
    } finally {
      this.busy = false;
    }
  }

  private showAvailable(): void {
    const update = this.update;
    if (!update) return;
    if (canSelfInstall(update.install)) {
      this.showChip(`Update ${update.version} available`, [
        { label: 'Install & Restart', onClick: () => void this.installAndRestart() },
        { label: 'Later', onClick: () => this.hide() },
      ]);
    } else if (update.install === 'package-manager') {
      this.showChip(`Update ${update.version} available — update via your package manager`, [
        this.dismissButton(),
      ]);
    } else {
      // Windows, a read-only /Applications, a translocated app: point at the
      // release page instead of asking for more privileges.
      this.showChip(`Update ${update.version} available`, [
        { label: 'Download', onClick: () => this.openReleasePage(update) },
        { label: 'Later', onClick: () => this.hide() },
      ]);
      if (this.chip && update.reason) this.chip.title = `Can't install here: ${update.reason}`;
    }
  }

  private openReleasePage(update: UpdateInfo): void {
    void invoke('open_external', { url: update.release_url }).catch((err) =>
      console.error('Opening the release page failed:', err),
    );
    this.hide();
  }

  private dismissButton(): ChipButton {
    return { label: 'Dismiss', onClick: () => this.hide() };
  }

  /** Render the status-bar chip, creating it on first use. */
  private showChip(text: string, buttons: ChipButton[], autoHideMs = 0): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    const chip = this.ensureChip();
    if (!chip) return;
    chip.replaceChildren();
    chip.title = '';
    const label = document.createElement('span');
    label.className = 'status-update-label';
    label.textContent = text;
    chip.appendChild(label);
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'status-update-btn';
      btn.textContent = b.label;
      btn.addEventListener('click', b.onClick);
      chip.appendChild(btn);
    }
    chip.classList.remove('hidden');
    if (autoHideMs > 0) this.hideTimer = setTimeout(() => this.hide(), autoHideMs);
  }

  private setLabel(text: string): void {
    const label = this.chip?.querySelector('.status-update-label');
    if (label) label.textContent = text;
  }

  private hide(): void {
    this.chip?.classList.add('hidden');
  }

  private ensureChip(): HTMLElement | null {
    if (this.chip?.isConnected) return this.chip;
    // index.html has the slot (right side, before the counters).
    const slot = document.getElementById('status-update');
    if (slot) {
      this.chip = slot;
      return slot;
    }
    const bar = document.getElementById('status-bar');
    if (!bar) return null;
    const chip = document.createElement('span');
    chip.id = 'status-update';
    chip.className = 'status-update hidden';
    // Right side, before the counters: visible but out of the way.
    bar.insertBefore(chip, document.getElementById('status-words'));
    this.chip = chip;
    return chip;
  }
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}
