import { describe, it, expect, vi, beforeEach } from 'vitest';

const emitTo = vi.fn(async () => {});
let label: string | null = 'main';

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => {
    if (!label) throw new Error('no runtime');
    return { label, emitTo };
  },
}));

describe('emitToSelf', () => {
  beforeEach(() => {
    emitTo.mockClear();
    label = 'main';
  });

  it('emits to the current webview window label', async () => {
    const { emitToSelf } = await import('../window-events');
    await emitToSelf('menu:open-folder');
    expect(emitTo).toHaveBeenCalledWith('main', 'menu:open-folder');
  });

  it('swallows a missing Tauri runtime (tests / browser)', async () => {
    label = null;
    const { emitToSelf } = await import('../window-events');
    await expect(emitToSelf('menu:x')).resolves.toBeUndefined();
    expect(emitTo).not.toHaveBeenCalled();
  });
});
