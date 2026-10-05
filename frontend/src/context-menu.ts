export interface ContextMenuItem {
  label: string;
  onClick: () => void;
}

let openMenu: HTMLElement | null = null;

/** Dismiss any open context menu. */
export function closeContextMenu(): void {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
  }
}

/**
 * Show a small themed context menu at the pointer. One menu at a time;
 * dismisses on outside click, Esc, scroll, or selecting an item.
 */
export function showContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
  closeContextMenu();

  const menu = document.createElement('div');
  menu.className = 'sd-ctxmenu';
  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'sd-ctxmenu-item';
    el.textContent = item.label;
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeContextMenu();
      item.onClick();
    });
    menu.appendChild(el);
  }

  // Position, then nudge back on-screen if it would overflow.
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.style.visibility = 'hidden';
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(4, window.innerWidth - rect.width - 4)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(4, window.innerHeight - rect.height - 4)}px`;
  menu.style.visibility = '';
  openMenu = menu;

  const dismiss = (e?: Event) => {
    // Ignore the click that opened it (handled via mousedown on items).
    // (window blur has a non-Node target.)
    if (e && e.target instanceof Node && menu.contains(e.target)) return;
    closeContextMenu();
    document.removeEventListener('mousedown', dismiss, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', dismiss);
    document.removeEventListener('scroll', dismiss, true);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss(); };
  // Defer so the opening right-click doesn't immediately dismiss it.
  setTimeout(() => {
    document.addEventListener('mousedown', dismiss, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', dismiss);
    document.addEventListener('scroll', dismiss, true);
  }, 0);
}
