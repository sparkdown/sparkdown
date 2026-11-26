// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { TabManager } from '../tabs';
import { EventBus } from '../events';

// The Linux and Windows e2e lanes read the unsaved dot with this script
// (e2e/lib/unsaved_dot.js). Every tab renders a dot element, hidden while the
// tab has no unsaved changes, so the script must look at whether the dot is
// displayed, not only whether it exists.
// Typed loosely: the frontend tsconfig has no Node types.
const { readFileSync } = (await import('node:fs' as string)) as {
  readFileSync(p: string, enc: 'utf8'): string;
};
const fromHere = (rel: string) => decodeURIComponent(new URL(rel, import.meta.url).pathname);
const SCRIPT = readFileSync(fromHere('../../../e2e/lib/unsaved_dot.js'), 'utf8');
const unsavedDotShown = () => new Function(SCRIPT)() as boolean;

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

function setup() {
  const tabs = new TabManager(new EventBus());
  const container = document.createElement('div');
  document.body.appendChild(container);
  tabs.init(container);
  return { tabs, container };
}

describe('e2e unsaved-dot script', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('is false for a saved tab even though its dot element exists', () => {
    const { tabs, container } = setup();
    tabs.openTab('/a/notes.md', 'alpha\n');
    expect(container.querySelectorAll('.tab-modified-dot')).toHaveLength(1);
    expect(unsavedDotShown()).toBe(false);
  });

  it('follows the active tab through an edit and a save', () => {
    const { tabs } = setup();
    tabs.openTab('/a/notes.md', 'alpha\n');
    const id = tabs.activeTab()!.id;
    tabs.setContentExternally(id, 'alpha\n e2e-last-key-Q');
    expect(unsavedDotShown()).toBe(true);
    expect(tabs.markSaved(id)).toBe(true);
    expect(unsavedDotShown()).toBe(false);
  });

  it('reads only the active tab, not other tabs with unsaved changes', () => {
    const { tabs } = setup();
    tabs.openTab('/a/other.md', 'x');
    tabs.setContentExternally(tabs.activeTab()!.id, 'x edited');
    tabs.openTab('/a/notes.md', 'alpha\n');
    expect(unsavedDotShown()).toBe(false);
  });
});
