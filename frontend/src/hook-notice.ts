/**
 * The title-strip notice for on-save hooks that failed while the Output tab
 * could not be shown (focus mode hides the drawer). The title strip stays in
 * focus mode, so the notice is seen there, and it stays after focus mode
 * ends until it is clicked (which opens Output), the Output tab is opened,
 * or a later save runs its hooks without a failure.
 */
export class HookNotice {
  constructor(
    private readonly el: HTMLElement | null,
    onClick: () => void,
  ) {
    el?.addEventListener('click', () => {
      this.clear();
      onClick();
    });
    document.getElementById('bottom-tab-output')?.addEventListener('click', () => this.clear());
  }

  /** Show which hooks failed. */
  show(names: string[]): void {
    const el = this.el;
    if (!el || names.length === 0) return;
    const text = names.length === 1 ? `On save: ${names[0]} failed` : `${names.length} on-save hooks failed`;
    el.textContent = text;
    el.title = `${text}. Click to see the Output tab.`;
    el.classList.remove('hidden');
  }

  clear(): void {
    this.el?.classList.add('hidden');
  }

  isShown(): boolean {
    return !!this.el && !this.el.classList.contains('hidden');
  }
}
