import { getCurrentWindow } from '@tauri-apps/api/window';
import { ask } from '@tauri-apps/plugin-dialog';
import { api, type QuitStatus } from '../api';
import type { AppContext } from './context';

/** What the quit flow needs from the App. */
export interface LifecycleDeps {
  /** Prompt for every dirty tab; false = cancelled or a save failed. */
  resolveUnsavedChanges(): Promise<boolean>;
  persistConfig(): Promise<void>;
  clearAgentContext(): Promise<void>;
  /** Unsubscribe all Tauri event listeners. */
  destroy(): void;
}

/** Window close / quit: hide to the dock, or resolve unsaved work and exit. */
export class LifecycleController {
  private quitting = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly deps: LifecycleDeps,
  ) {}

  /**
   * Window lifecycle guard. Rust forwards two events:
   *
   * - `close-requested` (red-X): on macOS we hide the window to the dock (Office
   *   model). But a hidden window's later dock-Quit fires an unpreventable
   *   RunEvent::Exit — so we MUST resolve unsaved changes *before* hiding,
   *   ensuring nothing can be lost once the window is in the dock. Rust does
   *   the actual hide() only after we report back that it's safe.
   * - `exit-requested` (Cmd+Q / dock Quit on a visible window): resolve unsaved
   *   changes, then exit.
   */
  registerCloseGuard(): void {
    this.ctx.listenTauri<{ mode?: 'hide' | 'close' } | null>('close-requested', (e) => {
      if (e.payload?.mode === 'close') void this.closeThisWindow();
      else void this.handleCloseToTray();
    });
    this.ctx.listenTauri('exit-requested', () => void this.requestQuit());
    // Another window is quitting the app (#65): resolve ours, then answer.
    this.ctx.listenTauri<{ id: number }>('quit-prepare', (e) => void this.prepareForOtherQuit(e.payload.id));
  }

  /** Close only this window (others stay open): resolve its unsaved tabs
   *  and its running terminals, save its session, then let the core close it. */
  private async closeThisWindow(): Promise<void> {
    if (this.quitting) return;
    if (!(await this.deps.resolveUnsavedChanges())) return;
    await this.deps.persistConfig();
    this.quitting = true;
    this.deps.destroy();
    await this.deps.clearAgentContext();
    await api.windowClose();
  }

  private async prepareForOtherQuit(id: number): Promise<void> {
    let ok = false;
    try {
      ok = await this.deps.resolveUnsavedChanges();
      if (ok) {
        await this.deps.persistConfig();
        await this.deps.clearAgentContext();
      }
    } finally {
      await api.quitPrepareReply(id, ok).catch(() => {});
    }
  }

  /** One confirm for every running terminal a quit would stop, across all
   *  windows, also listing the windows with unsaved changes (#68): one
   *  prompt shows everything the quit touches. True = go ahead (the save
   *  prompts for unsaved files follow). */
  private async confirmBusyTerminals(): Promise<boolean> {
    const status = await api.quitStatus().catch(() => ({ busy: [], unsaved: [] }));
    const text = quitConfirmText(status);
    if (!text) return true;
    try {
      return await ask(text, {
        title: 'Quit SparkDown',
        kind: 'warning',
        okLabel: 'Quit',
        cancelLabel: 'Cancel',
      });
    } catch {
      return false;
    }
  }

  /**
   * Red-X (macOS): hide to the dock, no prompt. Unsaved work stays live in the
   * hidden window, and a later Quit is still caught by the native
   * applicationShouldTerminate: hook (macos_quit.rs) which runs the save
   * prompt — so nothing can be lost without asking.
   */
  private async handleCloseToTray(): Promise<void> {
    await this.deps.persistConfig();
    await getCurrentWindow().hide();
  }

  /** Cmd+Q / dock Quit: prompt to save, then exit. A cancel aborts the quit. */
  async requestQuit(): Promise<void> {
    if (this.quitting) return;
    if (!(await this.confirmBusyTerminals())) return;
    const proceed = await this.deps.resolveUnsavedChanges();
    if (!proceed) return; // save failed/cancelled — abort quit
    // Every other window resolves its own unsaved tabs, in turn (#65).
    if (!(await api.quitPrepareOthers().catch(() => true))) return;
    await this.exitNow();
  }

  /** Update relaunch (updater.ts): the same unsaved-changes prompt as Quit.
   *  false = cancelled, a save failed, or a quit is already under way. */
  async resolveBeforeRestart(): Promise<boolean> {
    if (this.quitting) return false;
    return this.deps.resolveUnsavedChanges();
  }

  /** Flush config and terminate. Sets `quitting` so the close guard is a no-op. */
  private async exitNow(): Promise<void> {
    await this.prepareExit();
    await api.quit();
  }

  /** Everything exitNow does before the process ends. Also run just before
   *  an update relaunch. */
  async prepareExit(): Promise<void> {
    this.quitting = true;
    this.deps.destroy();
    await this.deps.persistConfig();
    await this.deps.clearAgentContext();
  }
}

/** The quit confirm's text, or null when no terminal is running (unsaved
 *  files alone get the usual save prompts). */
export function quitConfirmText(status: QuitStatus): string | null {
  const { busy, unsaved } = status;
  if (busy.length === 0) return null;
  const lines = busy
    .slice(0, 8)
    .map((b) => `• ${b.command} — ${b.window}`)
    .join('\n');
  const more = busy.length > 8 ? `\n…and ${busy.length - 8} more` : '';
  const n = busy.length === 1 ? 'A terminal is' : `${busy.length} terminals are`;
  const dirty = unsaved.length
    ? `\n\nUnsaved changes (you will be asked to save them):\n${unsaved
        .slice(0, 8)
        .map((w) => `• ${w}`)
        .join('\n')}`
    : '';
  return `${n} still running:\n\n${lines}${more}${dirty}\n\nQuit SparkDown and stop them?`;
}
