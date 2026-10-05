// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { ACTIONS, MENU } from '../event-names';
import { KEYBINDINGS } from '../shortcuts';
import { viewAccelerator } from '../activity-bar';

describe('KEYBINDINGS', () => {
  it('match the native menu accelerators (src-tauri/src/menu.rs)', async () => {
    // Typed loosely: the frontend tsconfig has no Node types.
    const fs: { readFileSync(p: URL, enc: string): string } = await import('node:fs' as string);
    const src = fs.readFileSync(new URL('../../../src-tauri/src/menu.rs', import.meta.url), 'utf8');
    const accels = new Map<string, string>();
    const re = /with_id\(\s*"([^"]+)",\s*"[^"]*",?\s*\)\s*\.accelerator\(\s*"([^"]+)"\s*\)/g;
    for (const m of src.matchAll(re)) accels.set(m[1], m[2]);
    expect(accels.get('quick-open')).toBe('CmdOrCtrl+P');

    // ACTIONS.X ↔ MENU.X share a key name (word wrap is the one alias).
    const alias: Record<string, string> = { TOGGLE_WRAP: 'TOGGLE_WORD_WRAP' };
    const menuIdFor = (actionKey: string) => {
      const ev = (MENU as Record<string, string>)[alias[actionKey] ?? actionKey];
      return ev?.startsWith('menu:') ? ev.slice('menu:'.length) : null;
    };
    let compared = 0;
    for (const [actionKey, action] of Object.entries(ACTIONS)) {
      const id = menuIdFor(actionKey);
      if (!id || !accels.has(id)) continue;
      expect(KEYBINDINGS[action], `${id} in menu.rs`).toBe(accels.get(id));
      compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(15);

    // The activity bar views keep their own table (activity-bar.ts).
    expect(accels.get('show-files')).toBe(viewAccelerator('files'));
    expect(accels.get('show-changes')).toBe(viewAccelerator('changes'));
    expect(accels.get('search-in-files')).toBe(viewAccelerator('search'));
    // No accelerator is claimed twice.
    const all = [...accels.values()];
    expect(new Set(all).size).toBe(all.length);
  });
});
