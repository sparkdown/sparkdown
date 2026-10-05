import { getCurrentWindow } from '@tauri-apps/api/window';
import { api } from './api';
import { isMacOS } from './utils';

export type OsKind = 'macos' | 'windows' | 'linux';

/** Classify the host OS for chrome (macOS overlay vs custom caption). */
export function osKind(): OsKind {
  if (isMacOS()) return 'macos';
  const p =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
      ?.platform ||
    navigator.platform ||
    '';
  if (/win/i.test(p)) return 'windows';
  return 'linux';
}

/**
 * Custom window chrome for Windows/Linux: the app icon (where macOS traffic
 * lights sit) opens the app menu; min/max/close sit on the right. macOS keeps
 * the overlay title bar and native menu, so this only tags <html> with `os-*`
 * and syncs fullscreen so CSS can reclaim the traffic-light gutter.
 */
export class Titlebar {
  private unlistenResize: (() => void) | null = null;
  private unlistenFullscreen: (() => void) | null = null;

  init(): void {
    const os = osKind();
    document.documentElement.classList.add(`os-${os}`);
    document.documentElement.dataset.os = os;
    if (os === 'macos') {
      // Overlay chrome keeps a fixed traffic-light gutter; reclaim it in fullscreen.
      this.bindFullscreenInset();
      return;
    }

    this.bindMenu();
    this.bindWindowControls();
    void this.syncMaximized();
  }

  destroy(): void {
    this.unlistenResize?.();
    this.unlistenResize = null;
    this.unlistenFullscreen?.();
    this.unlistenFullscreen = null;
  }

  /**
   * macOS Overlay titlebar reserves ~80px for traffic lights. In fullscreen
   * those controls hide, but the CSS gutter would otherwise leave the toolbar
   * / tab strip stuck inset. Toggle `is-fullscreen` on <html> so CSS can zero
   * the padding; restore on exit. Driven by onResized (fullscreen always
   * resizes) + an initial sync.
   */
  private bindFullscreenInset(): void {
    void this.syncFullscreen();
    void getCurrentWindow()
      .onResized(() => {
        void this.syncFullscreen();
      })
      .then((un) => {
        this.unlistenFullscreen = un;
      });
  }

  private async syncFullscreen(): Promise<void> {
    let fullscreen = false;
    try {
      fullscreen = await getCurrentWindow().isFullscreen();
    } catch {
      fullscreen = false;
    }
    document.documentElement.classList.toggle('is-fullscreen', fullscreen);
  }

  private bindMenu(): void {
    const btn = document.getElementById('btn-app-menu');
    if (!btn) return;
    // Track in-flight popup: show_app_menu blocks on Linux/Windows until the
    // native menu closes, and muda panics if a second popup starts while the
    // first still holds its RefCell (E2E P0). The prior fire-and-forget
    // `void showAppMenu(...)` let rapid clicks overlap.
    let menuOpen = false;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (menuOpen) return;
      // Anchor under the icon — do not rely on cursor position (Wayland).
      const rect = btn.getBoundingClientRect();
      menuOpen = true;
      void api.showAppMenu(rect.left, rect.bottom).finally(() => {
        menuOpen = false;
      });
    });
  }

  private bindWindowControls(): void {
    const win = getCurrentWindow();
    this.bindClick('btn-window-min', () => void win.minimize());
    this.bindClick('btn-window-max', () => void this.toggleMaximize());
    this.bindClick('btn-window-close', () => void win.close());

    void win.onResized(() => {
      void this.syncMaximized();
    }).then((un) => {
      this.unlistenResize = un;
    });
  }

  private async toggleMaximize(): Promise<void> {
    const win = getCurrentWindow();
    if (await win.isMaximized()) await win.unmaximize();
    else await win.maximize();
    await this.syncMaximized();
  }

  /**
   * Double-click on empty toolbar chrome toggles maximize / macOS Zoom.
   * Overlay title bars (macOS) and frameless caption bars (Windows/Linux) all
   * route through the toolbar dblclick handler in App.initToolbarDrag — there
   * is no native titlebar region left to own the gesture.
   */
  async onChromeDoubleClick(): Promise<void> {
    await this.toggleMaximize();
  }

  private async syncMaximized(): Promise<void> {
    const btn = document.getElementById('btn-window-max');
    if (!btn) return;
    let maximized = false;
    try {
      maximized = await getCurrentWindow().isMaximized();
    } catch {
      maximized = false;
    }
    btn.classList.toggle('is-maximized', maximized);
    const label = maximized ? 'Restore' : 'Maximize';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  private bindClick(id: string, handler: () => void): void {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handler();
    });
  }
}
