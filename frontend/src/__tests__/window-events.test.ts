import { describe, it, expect, vi, beforeEach } from 'vitest';

const listenMock = vi.fn(async () => () => {});
let label: string | null = 'w-abc';
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => {
    if (!label) throw new Error('no runtime');
    return { label };
  },
}));

describe('window-scoped listen (#61/#65)', () => {
  beforeEach(() => listenMock.mockClear());

  it("targets the current window so another window's emit_to never arrives", async () => {
    const { listen } = await import('../window-events');
    const h = () => {};
    await listen('terminal://data', h);
    expect(listenMock).toHaveBeenCalledWith('terminal://data', h, {
      target: { kind: 'WebviewWindow', label: 'w-abc' },
    });
  });

  it('falls back to a plain listen without a Tauri window (tests)', async () => {
    label = null;
    const { listen } = await import('../window-events');
    const h = () => {};
    await listen('x', h);
    expect(listenMock).toHaveBeenCalledWith('x', h);
    label = 'w-abc';
  });
});
