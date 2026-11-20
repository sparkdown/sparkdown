import { WebglAddon } from '@xterm/addon-webgl';
import type { ITerminalAddon } from '@xterm/xterm';

/**
 * One batch of pty output as it arrives over the terminal's Tauri Channel.
 * The backend sends raw UTF-8 bytes (`InvokeResponseBody::Raw`): large
 * batches arrive as an ArrayBuffer through the IPC fetch path, small ones
 * through `eval` as `new Uint8Array([...]).buffer`. Arrays are accepted too
 * so a JSON fallback can't break the pane.
 */
export type PtyOutput = ArrayBuffer | Uint8Array | number[];

/** Normalise a Channel message to bytes for `xterm.write`, without copying
 *  an ArrayBuffer or Uint8Array. */
export function ptyBytes(msg: PtyOutput): Uint8Array {
  if (msg instanceof Uint8Array) return msg;
  if (msg instanceof ArrayBuffer) return new Uint8Array(msg);
  return Uint8Array.from(msg);
}

/** The part of xterm's Terminal the renderer choice needs. */
interface AddonHost {
  loadAddon(addon: ITerminalAddon): void;
}

/** The part of WebglAddon used here (injectable for tests). */
interface WebglLike extends ITerminalAddon {
  onContextLoss(listener: () => void): { dispose(): void };
}

/**
 * True when this environment can create a WebGL2 context. Inject `probe` in
 * tests; the default creates a throwaway canvas (never loads the xterm addon
 * when the webview/GPU can't do WebGL2).
 */
export function webgl2Supported(
  probe: () => boolean = () => {
    try {
      if (typeof document === 'undefined') return false;
      // Prefer a real WebGL2RenderingContext constructor when present; jsdom
      // has canvas.getContext but no GPU, and calling it only logs noise.
      if (typeof (globalThis as { WebGL2RenderingContext?: unknown }).WebGL2RenderingContext === 'undefined') {
        return false;
      }
      const canvas = document.createElement('canvas');
      return !!canvas.getContext('webgl2');
    } catch {
      return false;
    }
  },
): boolean {
  return probe();
}

/**
 * Use xterm's WebGL renderer when the webview can provide a WebGL2 context,
 * else keep the built-in DOM renderer. Must run after `term.open()`.
 *
 * - No WebGL2 (some Linux GPU stacks, software-only WebKitGTK, jsdom): we
 *   never construct the addon; return 'dom' and xterm keeps the DOM renderer.
 * - Addon construction / activate throws: dispose what we can, return 'dom'.
 * - Context lost later (GPU reset, driver switch, sleep): dispose the addon,
 *   which hands rendering back to the DOM renderer with the existing buffer,
 *   and report it.
 *
 * Each call owns one addon instance for one terminal. Returns which renderer
 * is active after the attempt.
 */
export function loadWebglRenderer(
  term: AddonHost,
  onFallback: (reason: string) => void = () => {},
  make: () => WebglLike = () => new WebglAddon(),
  probeWebgl2: () => boolean = () => webgl2Supported(),
): 'webgl' | 'dom' {
  if (!probeWebgl2()) {
    onFallback('webgl2 unavailable');
    return 'dom';
  }
  let addon: WebglLike;
  try {
    addon = make();
  } catch (e) {
    onFallback(`webgl addon unavailable: ${e}`);
    return 'dom';
  }
  try {
    term.loadAddon(addon);
  } catch (e) {
    try {
      addon.dispose();
    } catch {
      // already torn down by the failed activate
    }
    onFallback(`webgl renderer failed to start: ${e}`);
    return 'dom';
  }
  addon.onContextLoss(() => {
    addon.dispose();
    onFallback('webgl context lost');
  });
  return 'webgl';
}
