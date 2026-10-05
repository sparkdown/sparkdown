// @vitest-environment jsdom
/**
 * Status bar path display: with a remote session, the path complements the
 * host chip (`~/relative`), and without one it stays the full path.
 * Character count lives beside words/lines and tracks selection when present.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api', () => ({ api: { copyText: vi.fn() } }));
vi.mock('../context-menu', () => ({ showContextMenu: vi.fn() }));

import { StatusBar } from '../statusbar';
import { EventBus } from '../events';
import { EVENTS } from '../event-names';

function mountBar(bus = new EventBus()): StatusBar {
  document.body.innerHTML = `
    <div id="status-bar">
      <span id="status-path"></span>
      <span id="status-modified"></span>
      <span id="status-words"></span>
      <span id="status-chars"></span>
      <span id="status-lines"></span>
      <span id="status-cursor"></span>
      <span id="status-wrap"></span>
    </div>`;
  const bar = new StatusBar(bus);
  bar.init();
  return bar;
}

const pathText = () => document.getElementById('status-path')!.textContent;
const charsText = () => document.getElementById('status-chars')!.textContent;

describe('StatusBar path base', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('shows the full path when no base is set', () => {
    const bar = mountBar();
    bar.setActiveFile('/local/home/u/proj/notes.md', 'notes.md');
    expect(pathText()).toBe('/local/home/u/proj/notes.md');
  });

  it('shows ~/relative under the base, and refreshes on base change', () => {
    const bar = mountBar();
    bar.setActiveFile('/local/home/u/proj/notes.md', 'notes.md');
    bar.setPathBase('/local/home/u');
    expect(pathText()).toBe('~/proj/notes.md');

    bar.setPathBase(null);
    expect(pathText()).toBe('/local/home/u/proj/notes.md');
  });

  it('does not shorten a sibling-prefix path or lose the base itself', () => {
    const bar = mountBar();
    bar.setPathBase('/local/home/u');
    bar.setActiveFile('/local/home/user2/a.md', 'a.md');
    expect(pathText()).toBe('/local/home/user2/a.md');

    bar.setActiveFile('/local/home/u', 'u');
    expect(pathText()).toBe('~');
  });

  it('shows the title for an unsaved buffer', () => {
    const bar = mountBar();
    bar.setPathBase('/local/home/u');
    bar.setActiveFile(null, 'Untitled');
    expect(pathText()).toBe('Untitled');
  });
});

describe('StatusBar character count', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('shows N chars for the document', () => {
    const bar = mountBar();
    bar.updateCounts(2, 1, 11);
    expect(charsText()).toBe('11 chars');
  });

  it('shows 0 chars cleanly for an empty buffer', () => {
    const bar = mountBar();
    bar.updateCounts(0, 1, 0);
    expect(charsText()).toBe('0 chars');
  });

  it('shows selected / total when a selection exists', () => {
    const bar = mountBar();
    bar.updateCounts(3, 1, 20, 5);
    expect(charsText()).toBe('5 selected / 20 chars');
  });

  it('refreshes from CURSOR_CHANGED even when line/col are unchanged', () => {
    const bus = new EventBus();
    mountBar(bus);
    bus.emit(EVENTS.CURSOR_CHANGED, {
      line: 1,
      column: 1,
      chars: 12,
      selectedChars: 4,
    });
    expect(charsText()).toBe('4 selected / 12 chars');

    bus.emit(EVENTS.CURSOR_CHANGED, {
      line: 1,
      column: 1,
      chars: 12,
      selectedChars: 0,
    });
    expect(charsText()).toBe('12 chars');
  });
});
