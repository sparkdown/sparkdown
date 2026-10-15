import { describe, it, expect, vi } from 'vitest';
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({}) }));
import { quitConfirmText } from '../app/lifecycle';

describe('quit confirm across windows (#68)', () => {
  it('lists running terminals and unsaved windows in one prompt', () => {
    const t = quitConfirmText({
      busy: [{ window: 'p2', command: 'sleep 300' }],
      unsaved: ['p1'],
    })!;
    expect(t).toContain('A terminal is still running');
    expect(t).toContain('• sleep 300 — p2');
    expect(t).toContain('Unsaved changes');
    expect(t).toContain('• p1');
  });

  it('asks nothing extra when no terminal is running', () => {
    expect(quitConfirmText({ busy: [], unsaved: ['p1'] })).toBeNull();
  });

  it('caps long lists', () => {
    const busy = Array.from({ length: 10 }, (_, i) => ({ window: 'w', command: `c${i}` }));
    const t = quitConfirmText({ busy, unsaved: [] })!;
    expect(t).toContain('10 terminals are');
    expect(t).toContain('…and 2 more');
    expect(t).not.toContain('Unsaved');
  });
});

describe('one quit flow (#88)', () => {
  it('names tmux programs that keep running and does not say it stops them', () => {
    const t = quitConfirmText({
      busy: [{ window: 'B', command: 'sleep', keeps_running: true }],
      unsaved: ['A'],
    })!;
    expect(t).toContain('• sleep — B (keeps running in tmux)');
    expect(t).toContain('• A');
    expect(t).toContain('Quit SparkDown?');
    expect(t).not.toContain('stop them');
  });
});
