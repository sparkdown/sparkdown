import { formatShortcut, terminalPaneAction } from './shortcuts';
import { isMacOS } from './utils';

/**
 * Find bar for a focused terminal pane. Mirrors the preview find widget
 * (floating, next/previous, Escape, match count) and drives an xterm
 * SearchAddon on the active pane.
 */
export interface TerminalSearchTarget {
  findNext(term: string, opts: { caseSensitive: boolean; incremental: boolean }): boolean;
  findPrevious(term: string, opts: { caseSensitive: boolean }): boolean;
  clearSearch(): void;
  onResults(cb: ((resultIndex: number, resultCount: number) => void) | null): void;
  focusTerminal(): void;
}

export class TerminalSearch {
  private host: HTMLElement;
  private dom: HTMLElement | null = null;
  private input!: HTMLInputElement;
  private count!: HTMLElement;
  private target: TerminalSearchTarget | null = null;
  private caseSensitive = false;
  private resultIndex = -1;
  private resultCount = 0;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  open(target: TerminalSearchTarget): void {
    this.detachResults();
    this.target = target;
    if (!this.dom) this.build();
    this.dom!.style.display = 'flex';
    this.target.onResults((index, total) => {
      this.resultIndex = index;
      this.resultCount = total;
      this.updateCount();
    });
    this.input.focus();
    this.input.select();
    if (this.input.value) this.run(true);
    else this.updateCount();
  }

  close(): void {
    this.target?.clearSearch();
    this.detachResults();
    const focusBack = this.target;
    this.target = null;
    this.resultIndex = -1;
    this.resultCount = 0;
    if (this.dom) this.dom.style.display = 'none';
    focusBack?.focusTerminal();
  }

  /** Pane closed: drop the listener and the DOM (no focus hand-back). */
  dispose(): void {
    this.detachResults();
    this.target = null;
    this.dom?.remove();
    this.dom = null;
  }

  isOpen(): boolean {
    return !!this.dom && this.dom.style.display !== 'none';
  }

  /** True when the find bar (or one of its controls) holds focus. */
  ownsFocus(element: Element | null): boolean {
    return !!element && !!this.dom && this.dom.contains(element);
  }

  private detachResults(): void {
    this.target?.onResults(null);
  }

  private build(): void {
    const dom = document.createElement('div');
    dom.className = 'sd-find sd-find-terminal';
    dom.setAttribute('role', 'search');
    const fields = document.createElement('div');
    fields.className = 'sd-find-fields';
    const row = document.createElement('div');
    row.className = 'sd-find-row';

    const wrap = document.createElement('div');
    wrap.className = 'sd-find-inputwrap';
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.placeholder = 'Find in terminal';
    this.input.className = 'sd-find-input';
    this.input.spellcheck = false;
    const tools = document.createElement('div');
    tools.className = 'sd-find-intools';
    const caseBtn = document.createElement('button');
    caseBtn.className = 'sd-find-mini';
    caseBtn.textContent = 'Aa';
    caseBtn.title = 'Match case';
    caseBtn.type = 'button';
    tools.appendChild(caseBtn);
    wrap.append(this.input, tools);

    this.count = document.createElement('span');
    this.count.className = 'sd-find-count';

    const prev = iconBtn(
      `Previous (${formatShortcut('Shift+Enter')})`,
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="6 11 12 5 18 11"/></svg>',
    );
    const next = iconBtn(
      'Next (⏎)',
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="6 13 12 19 18 13"/></svg>',
    );
    const closeB = iconBtn(
      'Close (Esc)',
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    );

    row.append(wrap, this.count, prev, next, closeB);
    fields.appendChild(row);
    dom.appendChild(fields);
    this.host.appendChild(dom);
    this.dom = dom;

    this.input.addEventListener('input', () => this.run(true));
    // Keys typed here belong to the bar: never to the terminal behind it or
    // the document shortcuts (Enter would otherwise reach nothing, Escape
    // would bubble to app-level handlers).
    this.input.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === 'F3') && !e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        this.step(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      } else if (terminalPaneAction(e, isMacOS()) === 'find' || isPlainModF(e)) {
        // Re-triggering Find while the bar is open just re-selects the query.
        e.preventDefault();
        e.stopPropagation();
        this.input.select();
      }
    });
    // Escape from the bar's buttons closes it too.
    dom.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.target === this.input) return;
      e.preventDefault();
      e.stopPropagation();
      this.close();
    });
    prev.onclick = () => this.step(-1);
    next.onclick = () => this.step(1);
    closeB.onclick = () => this.close();
    caseBtn.onclick = () => {
      this.caseSensitive = !this.caseSensitive;
      caseBtn.classList.toggle('active', this.caseSensitive);
      this.run(true);
      this.input.focus();
    };
  }

  private run(incremental: boolean): void {
    const term = this.input.value;
    if (!this.target) return;
    if (!term) {
      this.target.clearSearch();
      this.resultIndex = -1;
      this.resultCount = 0;
      this.updateCount();
      return;
    }
    this.target.findNext(term, { caseSensitive: this.caseSensitive, incremental });
  }

  private step(dir: number): void {
    if (!this.target || !this.input.value) return;
    if (dir < 0) {
      this.target.findPrevious(this.input.value, { caseSensitive: this.caseSensitive });
    } else {
      this.target.findNext(this.input.value, {
        caseSensitive: this.caseSensitive,
        incremental: false,
      });
    }
  }

  private updateCount(): void {
    if (!this.input.value) {
      this.count.textContent = '';
      this.count.classList.remove('sd-find-noresults');
      return;
    }
    if (this.resultCount <= 0) {
      this.count.textContent = 'No results';
      this.count.classList.add('sd-find-noresults');
      return;
    }
    this.count.classList.remove('sd-find-noresults');
    // SearchAddon reports -1 when the highlight limit is exceeded.
    if (this.resultIndex < 0) {
      this.count.textContent = `${this.resultCount}+`;
      return;
    }
    this.count.textContent = `${this.resultIndex + 1} of ${this.resultCount}`;
  }
}

/** ⌘F / Ctrl+F with no other modifier (the editor's Find key). */
function isPlainModF(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && !e.shiftKey && !e.altKey;
}

function iconBtn(title: string, svg: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'sd-find-icon';
  b.title = title;
  b.innerHTML = svg;
  b.type = 'button';
  return b;
}
