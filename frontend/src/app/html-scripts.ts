import { ask } from '@tauri-apps/plugin-dialog';
import type { PreviewPane } from '../preview';
import type { TabManager } from '../tabs';
import { isFramedFile } from '../utils';
import { api } from '../api';

/**
 * Per-file trust for running scripts in the HTML/SVG preview: the floating
 * JS button, the View-menu check, and the confirm prompt. Session-only — not
 * persisted, so it resets to off on every launch.
 */
export class HtmlScriptsController {
  /** Framed (HTML/SVG) files the user has opted into running scripts for this
   *  session, keyed `${origin}\0${absolute path}` (see activeFramedKey).
   *  Trust is per-file: enabling scripts for one's own trusted deck must NOT
   *  silently run scripts in a different (e.g. downloaded) .html opened
   *  later. Session-scoped; never persisted. */
  private scriptsAllowedPaths = new Set<string>();
  /** Last value pushed to the native View-menu check, to skip redundant IPC. */
  private lastHtmlJsMenuChecked = false;
  private htmlJsBtn: HTMLElement | null = null;

  constructor(
    private readonly tabs: TabManager,
    private readonly getPreview: () => PreviewPane | null,
  ) {}

  /**
   * Floating button in the preview pane to enable/disable JavaScript for HTML
   * previews — a discoverable alternative to the View-menu item. Only shown for
   * HTML tabs; mirrors the TOC trigger's placement and styling.
   */
  init(): void {
    const container = document.getElementById('preview-container');
    if (!container) return;
    const btn = document.createElement('div');
    btn.id = 'html-js-toggle';
    btn.className = 'preview-float-btn';
    // Official JavaScript logo (js-logo project, github.com/voodootikigod/logo.js)
    btn.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 630 630" xmlns="http://www.w3.org/2000/svg"><rect width="630" height="630" fill="#f7df1e"/><path d="m423.2 492.19c12.69 20.72 29.2 35.95 58.4 35.95 24.53 0 40.2-12.26 40.2-29.2 0-20.3-16.1-27.49-43.1-39.3l-14.8-6.35c-42.72-18.2-71.1-41-71.1-89.2 0-44.4 33.83-78.2 86.7-78.2 37.64 0 64.7 13.1 84.2 47.4l-46.1 29.6c-10.15-18.2-21.1-25.37-38.1-25.37-17.34 0-28.33 11-28.33 25.37 0 17.76 11 24.95 36.4 35.95l14.8 6.34c50.3 21.57 78.7 43.56 78.7 93 0 53.3-41.87 82.5-98.1 82.5-54.98 0-90.5-26.2-107.88-60.54zm-209.13 5.06c9.3 16.5 17.76 30.45 38.1 30.45 19.45 0 31.74-7.61 31.74-37.2v-201.3h59.2v202.1c0 61.3-35.94 89.2-88.4 89.2-47.4 0-74.85-24.53-88.81-54.075z"/></svg>';
    btn.addEventListener('click', () => this.toggle(true));
    container.appendChild(btn);
    this.htmlJsBtn = btn;
    this.updateButton();
  }

  /** Trust key for the active tab if it's a framed (HTML/SVG) file, else
   *  null. Keyed by origin + path: /tmp/deck.html on an SSH host and on this
   *  computer are different files, so trusting one must not trust the other. */
  private activeFramedKey(): string | null {
    const tab = this.tabs.activeTab();
    const path = tab?.path ?? null;
    if (!tab || !isFramedFile(path)) return null;
    return `${tab.origin ?? ''}\0${path}`;
  }

  /** Whether scripts are allowed for the file currently in the preview. */
  allowedForActive(): boolean {
    const key = this.activeFramedKey();
    return !!key && this.scriptsAllowedPaths.has(key);
  }

  /** Forget every trust decision (origin switch: the other machine's files
   *  are gone from view, and a same-path file here is not the trusted one). */
  reset(): void {
    this.scriptsAllowedPaths.clear();
    this.applyPolicy();
  }

  /**
   * Toggle script execution in the HTML preview. Session-only — not persisted,
   * so it resets to off on every launch.
   *
   * @param syncMenu when the toggle came from the floating button, also flip
   *   the View-menu checkmark. (When it came from the menu, the native
   *   CheckMenuItem has already flipped itself, so this is skipped.)
   */
  toggle(syncMenu: boolean): void {
    const key = this.activeFramedKey();
    // Only framed files carry a trust decision; nothing to toggle otherwise.
    if (!key) {
      this.applyPolicy(syncMenu);
      return;
    }
    if (!this.scriptsAllowedPaths.has(key)) {
      // Turning scripts ON runs the previewed document's own JavaScript. For an
      // untrusted .html that's a real capability grant (even sandboxed), so
      // confirm per file — trusting one deck must not enable a different one.
      void this.confirmEnable(key, syncMenu);
      return;
    }
    this.scriptsAllowedPaths.delete(key);
    this.applyPolicy(syncMenu);
  }

  private async confirmEnable(key: string, syncMenu: boolean): Promise<void> {
    const ok = await ask(
      'This runs the JavaScript inside the previewed HTML document, ' +
        'including any code and resources it loads from the internet. ' +
        'Only enable it for files you trust.\n\n' +
        'Enable JavaScript for HTML previews?',
      { title: 'Enable JavaScript?', kind: 'warning', okLabel: 'Enable', cancelLabel: 'Cancel' },
    ).catch(() => false);
    if (!ok) {
      // The native menu CheckMenuItem toggled itself before firing; put it
      // back to unchecked since we're not enabling.
      if (syncMenu === false) void api.setHtmlJsChecked(false);
      this.applyPolicy(syncMenu);
      return;
    }
    this.scriptsAllowedPaths.add(key);
    // The user may have switched tabs while the prompt was open; only push the
    // live preview/menu state, which applyPolicy derives from whatever
    // tab is active now.
    this.applyPolicy(syncMenu);
  }

  /**
   * Push the current per-path script-trust decision to the preview iframe, the
   * floating button, and (when it changed) the native menu check. Central point
   * so tab switches and toggles can't leave the three views disagreeing.
   */
  applyPolicy(syncMenu = true): void {
    const allowed = this.allowedForActive();
    this.getPreview()?.setAllowScripts(allowed);
    this.updateButton();
    if (syncMenu && allowed !== this.lastHtmlJsMenuChecked) {
      this.lastHtmlJsMenuChecked = allowed;
      void api.setHtmlJsChecked(allowed);
    }
  }

  /** Show the JS toggle only for framed (HTML/SVG) tabs; reflect on/off in its styling. */
  private updateButton(): void {
    if (!this.htmlJsBtn) return;
    const tab = this.tabs.activeTab();
    const show = isFramedFile(tab?.path ?? null);
    const allowed = this.allowedForActive();
    this.htmlJsBtn.classList.toggle('visible', show);
    this.htmlJsBtn.classList.toggle('active', allowed);
    this.htmlJsBtn.title = allowed
      ? 'JavaScript enabled in HTML preview — click to disable'
      : 'JavaScript disabled in HTML preview — click to enable';
  }
}
