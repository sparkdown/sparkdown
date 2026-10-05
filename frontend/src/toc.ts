import { EventBus } from './events';
import { slugifyHeading } from './utils';
import { TIMING } from './constants';
import { EVENTS } from './event-names';

interface TocEntry {
  level: number;
  text: string;
  lineNumber: number;
  id: string;
}

export class TOC {
  private bus: EventBus;
  private entries: TocEntry[] = [];
  private editorBtn!: HTMLElement;
  private previewBtn!: HTMLElement;
  private popup!: HTMLElement;
  private activeTarget: 'editor' | 'preview' = 'editor';

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  init(_container: HTMLElement): void {
    // Create TOC trigger buttons
    this.editorBtn = this.createTriggerButton('toc-btn-editor');
    this.previewBtn = this.createTriggerButton('toc-btn-preview');

    // Create shared popup
    this.popup = document.createElement('div');
    this.popup.id = 'toc-popup';
    document.getElementById('app')!.appendChild(this.popup);

    // Insert buttons into their panels
    const editorContainer = document.getElementById('editor-container');
    const previewContainer = document.getElementById('preview-container');
    if (editorContainer) editorContainer.appendChild(this.editorBtn);
    if (previewContainer) previewContainer.appendChild(this.previewBtn);

    // Hover behavior
    this.editorBtn.addEventListener('mouseenter', () => {
      this.activeTarget = 'editor';
      this.showPopup(this.editorBtn);
    });
    this.previewBtn.addEventListener('mouseenter', () => {
      this.activeTarget = 'preview';
      this.showPopup(this.previewBtn);
    });

    this.popup.addEventListener('mouseenter', () => this.cancelHide());
    this.popup.addEventListener('mouseleave', () => this.scheduleHide());
  }

  private createTriggerButton(id: string): HTMLElement {
    const btn = document.createElement('div');
    btn.id = id;
    btn.className = 'toc-trigger';
    btn.title = 'Table of Contents';
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/></svg>';
    btn.addEventListener('mouseleave', () => this.scheduleHide());
    return btn;
  }

  update(markdown: string): void {
    this.entries = [];
    const lines = markdown.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
      if (match) {
        const text = match[2].trim();
        this.entries.push({
          level: match[1].length,
          text,
          lineNumber: i + 1,
          id: slugifyHeading(text),
        });
      }
    }
    // Show/hide trigger buttons based on whether there are headings
    const hasEntries = this.entries.length > 0;
    this.editorBtn.classList.toggle('has-entries', hasEntries);
    this.previewBtn.classList.toggle('has-entries', hasEntries);
  }

  private renderPopup(): void {
    this.popup.innerHTML = '';
    if (this.entries.length === 0) return;

    const title = document.createElement('div');
    title.className = 'toc-popup-title';
    title.textContent = 'Outline';
    this.popup.appendChild(title);

    for (const entry of this.entries) {
      const el = document.createElement('div');
      el.className = `toc-popup-item toc-level-${entry.level}`;
      el.textContent = entry.text;
      el.style.paddingLeft = `${(entry.level - 1) * 12 + 8}px`;
      el.addEventListener('click', () => {
        if (this.activeTarget === 'editor') {
          this.bus.emit(EVENTS.TOC_GOTO_LINE, { line: entry.lineNumber });
        } else {
          this.bus.emit(EVENTS.TOC_SCROLL_PREVIEW, { id: entry.id });
        }
        this.hidePopup();
      });
      this.popup.appendChild(el);
    }
  }

  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  private showPopup(anchor: HTMLElement): void {
    this.cancelHide();
    if (this.entries.length === 0) return;
    this.renderPopup();

    // Position popup near the anchor button
    const rect = anchor.getBoundingClientRect();
    this.popup.style.top = `${rect.bottom + 4}px`;
    this.popup.style.right = `${window.innerWidth - rect.right}px`;
    this.popup.classList.add('visible');
  }

  private hidePopup(): void {
    this.popup.classList.remove('visible');
  }

  private scheduleHide(): void {
    this.cancelHide();
    this.hideTimer = setTimeout(() => this.hidePopup(), TIMING.TOC_HIDE_MS);
  }

  private cancelHide(): void {
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
  }
}
