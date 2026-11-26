// @vitest-environment jsdom
/**
 * Saving, switching tabs, closing a tab and quitting right after a keystroke.
 *
 * CodeMirror applies typed text from DOM mutations in a MutationObserver
 * callback. These tests change the editor's DOM the way a keystroke does and
 * then act in the same tick, before that callback runs, so they cover the
 * case where the last keystroke is in the DOM but not yet in the editor state.
 */
import './helpers/dom-shims';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const disk = new Map<string, string>();
const messageMock = vi.fn(async (): Promise<string> => 'Yes');

vi.mock('../api', () => ({
  api: {
    readFile: vi.fn(async (path: string) => disk.get(path) ?? ''),
    writeFile: vi.fn(async (path: string, content: string) => {
      disk.set(path, content);
    }),
  },
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(async () => null),
  message: (...args: unknown[]) => (messageMock as (...a: unknown[]) => unknown)(...args),
}));

import { EditorView } from '@codemirror/view';
import { DocumentController } from '../app/documents';
import { EditorManager } from '../editor';
import { TabManager } from '../tabs';
import { EventBus } from '../events';
import { EVENTS } from '../event-names';

const PATH = '/p/note.md';
const OTHER = '/p/other.md';

/** The editor, tabs and save controller, wired the way app.ts wires them. */
function setup(initial: string) {
  document.body.innerHTML = '<div id="md-toolbar"></div><div id="tabs"></div><div id="host"></div>';
  const bus = new EventBus();
  const tabs = new TabManager(bus);
  tabs.init(document.getElementById('tabs')!);
  const editor = new EditorManager(bus, true);
  editor.init(document.getElementById('host')!);
  tabs.setPendingInputFlush(() => editor.flushPendingInput());
  bus.on(EVENTS.CONTENT_CHANGED, (data) => {
    tabs.updateContent(data.content);
    tabs.refreshModified();
  });
  bus.on(EVENTS.TAB_SAVE_STATE, (data) => {
    const content = editor.getContent();
    tabs.setContentFor(data.tabId, content);
    editor.saveStateFor(data.tabId);
  });
  const confirmClose = vi.fn();
  bus.on(EVENTS.CONFIRM_CLOSE_TAB, confirmClose);
  disk.set(PATH, initial);
  tabs.openTab(PATH, initial);
  editor.loadFresh(initial, PATH);
  const fileTree = { getSaveDir: () => '/p' };
  const docs = new DocumentController({ tabs, editor, fileTree } as never, {} as never);
  const view = EditorView.findFromDOM(document.querySelector('.cm-content')!)!;
  return { bus, tabs, editor, docs, view, confirmClose };
}

/** Append `text` to the end of the document's DOM, as a keystroke does,
 *  without waiting for CodeMirror's observer to pick it up. */
function typeInDom(view: EditorView, text: string): void {
  const lines = view.contentDOM.querySelectorAll('.cm-line');
  const walker = document.createTreeWalker(lines[lines.length - 1], NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) last = n as Text;
  if (!last) throw new Error('no text node to type into');
  last.data += text;
}

describe('keystrokes not yet applied by the editor', () => {
  beforeEach(() => {
    disk.clear();
    messageMock.mockReset();
    messageMock.mockResolvedValue('Yes');
  });

  it('the editor state lags the DOM until the observer runs (the case below)', async () => {
    const { view } = setup('hello');
    typeInDom(view, '!');
    expect(view.state.doc.toString()).toBe('hello');
    await Promise.resolve();
    expect(view.state.doc.toString()).toBe('hello!');
  });

  it('getContent includes a keystroke that is only in the DOM', () => {
    const { editor, view } = setup('hello');
    typeInDom(view, '!');
    expect(editor.getContent()).toBe('hello!');
  });

  it('save started in the same tick as the last keystroke writes it and clears the modified dot', async () => {
    const { docs, tabs, view } = setup('hello');
    typeInDom(view, ' world');
    const saved = docs.save();
    expect(await saved).toBe(true);
    expect(disk.get(PATH)).toBe('hello world');
    expect(tabs.activeTab()?.modified).toBe(false);
    expect(tabs.activeTab()?.savedContent).toBe('hello world');
  });

  it('Save As in the same tick writes the last keystroke', async () => {
    const { docs, view } = setup('draft');
    const { save } = await import('@tauri-apps/plugin-dialog');
    vi.mocked(save).mockResolvedValueOnce('/p/new.md');
    typeInDom(view, 'X');
    expect(await docs.saveAs()).toBe(true);
    expect(disk.get('/p/new.md')).toBe('draftX');
  });

  it('switching tabs keeps the last keystroke in the tab that was left', () => {
    const { tabs, editor, view } = setup('alpha');
    const first = tabs.activeTab()!.id;
    typeInDom(view, 'Z');
    disk.set(OTHER, 'beta');
    tabs.openTab(OTHER, 'beta');
    editor.loadFresh('beta', OTHER);
    const left = tabs.getTab(first)!;
    expect(left.content).toBe('alphaZ');
    expect(left.modified).toBe(true);
    // The new tab's text was not touched by the old tab's keystroke.
    expect(editor.getContent()).toBe('beta');
  });

  it('closing a clean tab right after a keystroke asks to save instead of closing', () => {
    const { tabs, view, confirmClose } = setup('alpha');
    typeInDom(view, 'Z');
    tabs.closeCurrent();
    expect(confirmClose).toHaveBeenCalledTimes(1);
    expect(tabs.activeTab()?.content).toBe('alphaZ');
  });

  it("a tab's close button right after a keystroke asks to save instead of closing", () => {
    const { view, confirmClose } = setup('alpha');
    typeInDom(view, 'Z');
    const close = document.querySelector<HTMLElement>('.tab .tab-close')!;
    close.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(confirmClose).toHaveBeenCalledTimes(1);
  });

  it('quitting right after a keystroke prompts for that tab and saves the full text', async () => {
    const { docs, tabs, view } = setup('alpha');
    typeInDom(view, 'Z');
    expect(await docs.resolveUnsavedChanges()).toBe(true);
    expect(messageMock).toHaveBeenCalledTimes(1);
    expect(disk.get(PATH)).toBe('alphaZ');
    expect(tabs.activeTab()?.modified).toBe(false);
  });

  it('reading the text from inside an editor update does not throw', () => {
    const { bus, editor, view } = setup('alpha');
    const seen: string[] = [];
    bus.on(EVENTS.CONTENT_CHANGED, () => seen.push(editor.getContent()));
    view.dispatch({ changes: { from: 5, insert: '1' } });
    expect(seen).toEqual(['alpha1']);
  });
});
