// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { osKind, Titlebar } from '../titlebar';

vi.mock('@tauri-apps/api/core', async () => (await import('./helpers/tauri-mocks')).coreMock);
vi.mock('@tauri-apps/api/window', async () => (await import('./helpers/tauri-mocks')).windowMock);

const chromeHtml = `
  <div id="toolbar">
    <div class="toolbar-start">
      <button id="btn-app-menu" class="app-icon-btn"></button>
    </div>
    <button id="btn-new" class="toolbar-btn"></button>
    <div class="window-controls">
      <button id="btn-window-min" class="window-control"></button>
      <button id="btn-window-max" class="window-control"></button>
      <button id="btn-window-close" class="window-control window-control-close"></button>
    </div>
  </div>`;

describe('osKind', () => {
  const originalPlatform = navigator.platform;

  afterEach(() => {
    Object.defineProperty(navigator, 'platform', { value: originalPlatform, configurable: true });
  });

  it('detects macOS', () => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    expect(osKind()).toBe('macos');
  });

  it('detects Windows', () => {
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    expect(osKind()).toBe('windows');
  });

  it('falls back to linux', () => {
    Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true });
    expect(osKind()).toBe('linux');
  });
});

describe('Titlebar', () => {
  beforeEach(() => {
    document.documentElement.className = '';
    delete document.documentElement.dataset.os;
    document.body.innerHTML = chromeHtml;
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.documentElement.className = '';
  });

  it('tags html with os-windows', () => {
    new Titlebar().init();
    expect(document.documentElement.classList.contains('os-windows')).toBe(true);
    expect(document.documentElement.dataset.os).toBe('windows');
  });

  it('on macOS sets the os class and binds fullscreen inset sync', async () => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    vi.mocked(win.onResized).mockClear();
    vi.mocked(win.isFullscreen).mockResolvedValue(false);
    new Titlebar().init();
    expect(document.documentElement.classList.contains('os-macos')).toBe(true);
    expect(win.onResized).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(document.documentElement.classList.contains('is-fullscreen')).toBe(false);
    });
  });

  it('clicking the icon invokes show_app_menu anchored under the button', async () => {
    const { invokeCalls } = await import('./helpers/tauri-mocks');
    invokeCalls.length = 0;
    const btn = document.getElementById('btn-app-menu')!;
    vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue({
      left: 12,
      top: 4,
      right: 40,
      bottom: 32,
      width: 28,
      height: 28,
      x: 12,
      y: 4,
      toJSON: () => ({}),
    } as DOMRect);
    new Titlebar().init();
    btn.click();
    await vi.waitFor(() => {
      expect(invokeCalls.some((c) => c.cmd === 'show_app_menu')).toBe(true);
    });
    const call = invokeCalls.find((c) => c.cmd === 'show_app_menu');
    expect(call!.args).toEqual({ x: 12, y: 32 });
  });

  it('ignores a second brand-icon click while the menu invoke is in flight', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { api } = await import('../api');
    const spy = vi.spyOn(api, 'showAppMenu').mockReturnValue(blocked);
    const btn = document.getElementById('btn-app-menu')!;
    vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue({
      left: 12,
      top: 4,
      right: 40,
      bottom: 32,
      width: 28,
      height: 28,
      x: 12,
      y: 4,
      toJSON: () => ({}),
    } as DOMRect);
    new Titlebar().init();
    btn.click();
    btn.click();
    expect(spy).toHaveBeenCalledTimes(1);
    release();
    await blocked;
    spy.mockRestore();
  });

  it('wires min/max/close on Windows', async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    vi.mocked(win.minimize).mockClear();
    vi.mocked(win.close).mockClear();
    new Titlebar().init();
    document.getElementById('btn-window-min')!.click();
    document.getElementById('btn-window-close')!.click();
    expect(win.minimize).toHaveBeenCalled();
    expect(win.close).toHaveBeenCalled();
  });

  it('chrome double-click maximizes on Windows', async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    vi.mocked(win.maximize).mockClear();
    vi.mocked(win.unmaximize).mockClear();
    vi.mocked(win.isMaximized).mockResolvedValue(false);
    const tb = new Titlebar();
    tb.init();
    await tb.onChromeDoubleClick();
    expect(win.maximize).toHaveBeenCalled();
    expect(win.unmaximize).not.toHaveBeenCalled();
  });

  it('chrome double-click restores when already maximized', async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    vi.mocked(win.maximize).mockClear();
    vi.mocked(win.unmaximize).mockClear();
    vi.mocked(win.isMaximized).mockResolvedValue(true);
    const tb = new Titlebar();
    tb.init();
    await tb.onChromeDoubleClick();
    expect(win.unmaximize).toHaveBeenCalled();
    expect(win.maximize).not.toHaveBeenCalled();
  });

  it('chrome double-click zooms (maximize) on macOS overlay chrome', async () => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    vi.mocked(win.maximize).mockClear();
    vi.mocked(win.unmaximize).mockClear();
    vi.mocked(win.isMaximized).mockResolvedValue(false);
    const tb = new Titlebar();
    tb.init();
    await tb.onChromeDoubleClick();
    expect(win.maximize).toHaveBeenCalled();
    expect(win.unmaximize).not.toHaveBeenCalled();
  });
  it('tags is-fullscreen when macOS window is fullscreen', async () => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    vi.mocked(win.isFullscreen).mockResolvedValue(true);
    new Titlebar().init();
    await vi.waitFor(() => {
      expect(document.documentElement.classList.contains('is-fullscreen')).toBe(true);
    });
  });

  it('clears is-fullscreen when leaving fullscreen via onResized', async () => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    let resizedHandler: ((event?: unknown) => void) | null = null;
    vi.mocked(win.onResized).mockImplementation(async (handler) => {
      resizedHandler = handler as (event?: unknown) => void;
      return () => {};
    });
    vi.mocked(win.isFullscreen).mockResolvedValue(true);
    new Titlebar().init();
    await vi.waitFor(() => {
      expect(document.documentElement.classList.contains('is-fullscreen')).toBe(true);
    });
    vi.mocked(win.isFullscreen).mockResolvedValue(false);
    resizedHandler!();
    await vi.waitFor(() => {
      expect(document.documentElement.classList.contains('is-fullscreen')).toBe(false);
    });
  });
});
