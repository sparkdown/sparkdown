import { getCurrentWindow } from '@tauri-apps/api/window';
import { api } from '../api';
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
    this.ctx.listenTauri('close-requested', () => void this.handleCloseToTray());
    this.ctx.listenTauri('exit-requested', () => void this.requestQuit());
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
    const proceed = await this.deps.resolveUnsavedChanges();
    if (!proceed) return; // save failed/cancelled — abort quit
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
