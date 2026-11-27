// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { showShortcutsDialog } from '../shortcuts-dialog';
import { tabSwitchLabel } from '../shortcuts';

afterEach(() => {
  if (document.querySelector('.shortcuts-overlay')) showShortcutsDialog();
  document.body.innerHTML = '';
  document.querySelectorAll('style[data-shortcuts-css]').forEach((el) => el.remove());
  Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
});

function row(label: string): { desc: HTMLElement; key: HTMLElement } {
  for (const r of document.querySelectorAll('.shortcut-row')) {
    const desc = r.querySelector('.shortcut-desc');
    if (desc?.textContent === label) {
      return { desc: desc as HTMLElement, key: r.querySelector('kbd') as HTMLElement };
    }
  }
  throw new Error(`missing row: ${label}`);
}

describe('shortcuts dialog layout', () => {
  it('keeps Next Tab and Previous Tab labels readable and lets the keys wrap', async () => {
    const fs: { readFileSync(p: string, enc: string): string } = await import('node:fs' as string);
    // jsdom's import.meta.url is not a file URL; vitest's cwd is frontend/.
    const css = fs.readFileSync('src/styles/shortcuts.css', 'utf8');
    expect(css).toMatch(/\.shortcut-desc\s*\{[^}]*min-width:\s*[1-9]\d*em/);
    expect(css).toMatch(/\.shortcuts-dialog kbd\s*\{[^}]*white-space:\s*normal/);
    expect(css).not.toMatch(/\.shortcuts-dialog kbd\s*\{[^}]*white-space:\s*nowrap/);

    const style = document.createElement('style');
    style.dataset.shortcutsCss = '1';
    style.textContent = css;
    document.head.appendChild(style);

    Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true });
    showShortcutsDialog();

    const next = row('Next Tab');
    const prev = row('Previous Tab');
    expect(next.key.textContent).toBe(tabSwitchLabel('next', false));
    expect(prev.key.textContent).toBe(tabSwitchLabel('prev', false));
    expect(tabSwitchLabel('next', false)).toContain(' / ');

    expect(getComputedStyle(next.desc).minWidth).not.toBe('0px');
    expect(getComputedStyle(next.key).whiteSpace).toBe('normal');
    expect(getComputedStyle(prev.desc).minWidth).not.toBe('0px');
    expect(getComputedStyle(prev.key).whiteSpace).toBe('normal');
  });
});
