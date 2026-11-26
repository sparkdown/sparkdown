/**
 * The Output tab in the bottom pane: logs from custom palette commands
 * and on-save hooks. Same visual language as the Git tab (git-output.ts).
 */

import { escapeHtml, escapeReviewText } from './utils';

export type RunLogState = 'running' | 'ok' | 'error';

export interface RunLogEntry {
  id: number;
  kind: string;
  name: string;
  command: string;
  at: Date;
  state: RunLogState;
  message: string;
  output: string;
}

export class UserRunOutputLog {
  private entries: RunLogEntry[] = [];
  private nextId = 1;

  constructor(private readonly el: HTMLElement | null) {
    this.render();
  }

  all(): readonly RunLogEntry[] {
    return this.entries;
  }

  start(kind: string, name: string, command: string): RunLogEntry {
    const entry: RunLogEntry = {
      id: this.nextId++,
      kind,
      name,
      command,
      at: new Date(),
      state: 'running',
      message: 'Running…',
      output: '',
    };
    this.entries.push(entry);
    this.render();
    return entry;
  }

  finish(entry: RunLogEntry, state: 'ok' | 'error', message: string, output: string): void {
    entry.state = state;
    entry.message = message;
    entry.output = output;
    this.render();
  }

  note(kind: string, name: string, message: string, output = ''): RunLogEntry {
    const entry: RunLogEntry = {
      id: this.nextId++,
      kind,
      name,
      command: '',
      at: new Date(),
      state: 'error',
      message,
      output,
    };
    this.entries.push(entry);
    this.render();
    return entry;
  }

  scrollToEnd(): void {
    if (this.el) this.el.scrollTop = this.el.scrollHeight;
  }

  private render(): void {
    if (!this.el) return;
    if (this.entries.length === 0) {
      this.el.innerHTML =
        '<div class="git-output-empty">Output from custom commands appears here.</div>';
      return;
    }
    this.el.innerHTML = this.entries
      .map((e) => {
        const time = e.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const cmd = e.command
          ? `<code class="git-output-cmd">$ ${escapeHtml(e.command)}</code> `
          : '';
        const body = e.output ? `<pre class="git-output-text">${escapeReviewText(e.output)}</pre>` : '';
        return (
          `<section class="git-output-entry" data-state="${e.state}" data-id="${e.id}">` +
          `<div class="git-output-head"><span class="git-output-time">${escapeHtml(time)}</span> ` +
          `<span class="git-output-kind">${escapeHtml(e.kind)}</span> ` +
          `<span class="git-output-name">${escapeHtml(e.name)}</span> ` +
          cmd +
          `<span class="git-output-msg">${escapeReviewText(e.message)}</span></div>` +
          body +
          `</section>`
        );
      })
      .join('');
    this.scrollToEnd();
  }
}
