/**
 * Keys typed while the terminal drawer is opening.
 *
 * The first reveal loads the terminal code and starts a shell, which takes a
 * moment. Focus stays in the editor meanwhile, so the first letters typed
 * after the shortcut would land in the document and the rest in the shell.
 * This hidden box takes focus as soon as the drawer opens, collects what is
 * typed, and hands it to the new shell in order (Enter becomes CR).
 */
export class TypeAhead {
  private box: HTMLTextAreaElement | null = null;

  constructor(private readonly host: () => HTMLElement | null) {}

  /** Start collecting keys: move focus into the hidden box. */
  start(): void {
    if (this.box) return;
    const host = this.host();
    if (!host) return;
    const box = document.createElement('textarea');
    box.className = 'terminal-type-ahead';
    box.tabIndex = -1;
    box.spellcheck = false;
    box.autocomplete = 'off';
    box.setAttribute('autocapitalize', 'off');
    box.setAttribute('aria-hidden', 'true');
    // Tab would move focus away; a terminal wants the character.
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        box.value += '\t';
      }
    });
    host.appendChild(box);
    box.focus({ preventScroll: true });
    this.box = box;
  }

  /** The text collected so far, ready for a pty; removes the box. */
  take(): string {
    const box = this.box;
    if (!box) return '';
    const text = box.value.replace(/\r?\n/g, '\r');
    this.discard();
    return text;
  }

  /** Remove the box and drop whatever it holds. */
  discard(): void {
    this.box?.remove();
    this.box = null;
  }
}
