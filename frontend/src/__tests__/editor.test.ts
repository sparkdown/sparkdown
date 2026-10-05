// @vitest-environment jsdom
/**
 * Unit tests for EditorManager's formatting helpers and text metrics
 * (spec task 3.6 / issue #9). Uses the real CodeMirror view under jsdom;
 * selections are driven through the view found via EditorView.findFromDOM,
 * matching the approach in app.integration.test.ts.
 */
import './helpers/dom-shims';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorManager } from '../editor';
import { EventBus } from '../events';
import { ACTIONS } from '../event-names';

function setup(content = '', wordWrap = true) {
  document.body.innerHTML = '<div id="md-toolbar"></div><div id="host"></div>';
  const editor = new EditorManager(new EventBus(), wordWrap);
  editor.init(document.getElementById('host')!);
  if (content) editor.loadFresh(content, 'notes.md');
  const view = EditorView.findFromDOM(document.querySelector('.cm-content')!)!;
  return { editor, view };
}

/** Place the selection by absolute document offsets. */
function select(view: EditorView, anchor: number, head = anchor) {
  view.dispatch({ selection: { anchor, head } });
}

describe('EditorManager text metrics', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('getWordCount', () => {
    it('is 0 for an empty document', () => {
      expect(setup('').editor.getWordCount()).toBe(0);
    });

    it('is 0 for whitespace-only content', () => {
      expect(setup('   \n\t  \n').editor.getWordCount()).toBe(0);
    });

    it('counts words separated by any whitespace', () => {
      expect(setup('one two three').editor.getWordCount()).toBe(3);
      expect(setup('one   two\nthree\tfour').editor.getWordCount()).toBe(4);
    });

    it('ignores leading and trailing whitespace', () => {
      expect(setup('  hello world  ').editor.getWordCount()).toBe(2);
    });

    it('counts punctuation-attached tokens as single words', () => {
      expect(setup('well-known, e.g. state-of-the-art!').editor.getWordCount()).toBe(3);
    });
  });

  describe('getCharCount', () => {
    it('is 0 for an empty document', () => {
      expect(setup('').editor.getCharCount()).toBe(0);
    });

    it('counts every character including spaces and newlines', () => {
      expect(setup('hi').editor.getCharCount()).toBe(2);
      expect(setup('a\nb').editor.getCharCount()).toBe(3);
      expect(setup('  x  ').editor.getCharCount()).toBe(5);
    });
  });

  describe('getSelectedCharCount', () => {
    it('is 0 when the caret is empty', () => {
      expect(setup('hello').editor.getSelectedCharCount()).toBe(0);
    });

    it('returns the primary selection length', () => {
      const { editor, view } = setup('hello world');
      select(view, 0, 5); // "hello"
      expect(editor.getSelectedCharCount()).toBe(5);
    });
  });

  describe('headingSourceLines', () => {
    it('returns 1-based ATX heading lines, skipping fenced code', () => {
      const { editor } = setup('# A\n\ntext\n\n```\n# not a heading\n```\n\n## B\n');
      expect(editor.headingSourceLines()).toEqual([1, 9]);
    });

    it('caches per document version (same array while the doc is unchanged)', () => {
      const { editor } = setup('# A\n\n## B\n');
      const first = editor.headingSourceLines();
      expect(editor.headingSourceLines()).toBe(first);
    });

    it('recomputes after an edit changes the document', () => {
      const { editor, view } = setup('# A\n');
      expect(editor.headingSourceLines()).toEqual([1]);
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\n## B\n' } });
      expect(editor.headingSourceLines()).toEqual([1, 3]);
    });
  });

  describe('getLineCount', () => {
    it('is 1 for an empty document', () => {
      expect(setup('').editor.getLineCount()).toBe(1);
    });

    it('counts newline-separated lines', () => {
      expect(setup('a\nb\nc').editor.getLineCount()).toBe(3);
    });

    it('counts the empty final line after a trailing newline', () => {
      expect(setup('a\nb\n').editor.getLineCount()).toBe(3);
    });
  });
});

describe('EditorManager formatting helpers', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('wrapSelection', () => {
    it('wraps a selected range and keeps the text selected', () => {
      const { editor, view } = setup('make me bold');
      select(view, 8, 12); // "bold"
      editor.wrapSelection('**', '**');
      expect(editor.getContent()).toBe('make me **bold**');
      const sel = view.state.selection.main;
      expect(view.state.sliceDoc(sel.from, sel.to)).toBe('bold');
    });

    it('inserts empty markers at the cursor when nothing is selected', () => {
      const { editor, view } = setup('ab');
      select(view, 1); // between a and b
      editor.wrapSelection('**', '**');
      expect(editor.getContent()).toBe('a****b');
      // Cursor lands between the marker pairs, ready to type.
      expect(view.state.selection.main.from).toBe(3);
    });

    it('supports asymmetric delimiters (link syntax)', () => {
      const { editor, view } = setup('click here');
      select(view, 6, 10); // "here"
      editor.wrapSelection('[', '](url)');
      expect(editor.getContent()).toBe('click [here](url)');
    });
  });

  describe('insertAtCursor', () => {
    it('inserts text at a collapsed cursor', () => {
      const { editor, view } = setup('ac');
      select(view, 1);
      editor.insertAtCursor('b');
      expect(editor.getContent()).toBe('abc');
    });

    it('inserts at the selection head without replacing the range', () => {
      // insertAtCursor targets selection.head (used for toolbar inserts like
      // images/tables), so it appends at the caret rather than overwriting.
      const { editor, view } = setup('foo BAR baz');
      select(view, 4, 7); // head at offset 7, just after "BAR"
      editor.insertAtCursor('qux');
      expect(editor.getContent()).toBe('foo BARqux baz');
    });
  });

  describe('insertLinePrefix', () => {
    it('prepends the prefix at the start of the cursor line', () => {
      const { editor, view } = setup('line one\nline two\nline three');
      select(view, 12); // somewhere in "line two"
      editor.insertLinePrefix('> ');
      expect(editor.getContent()).toBe('line one\n> line two\nline three');
    });

    it('prefixes the first line when the cursor is at the top', () => {
      const { editor, view } = setup('heading');
      select(view, 3);
      editor.insertLinePrefix('## ');
      expect(editor.getContent()).toBe('## heading');
    });
  });

  describe('formatting keymap', () => {
    /** Setup that also wires a fresh EventBus so we can observe emitted actions. */
    function setupWithBus(content = '') {
      document.body.innerHTML = '<div id="md-toolbar"></div><div id="host"></div>';
      const bus = new EventBus();
      const editor = new EditorManager(bus, true);
      editor.init(document.getElementById('host')!);
      if (content) editor.loadFresh(content, 'notes.md');
      const view = EditorView.findFromDOM(document.querySelector('.cm-content')!)!;
      return { bus, editor, view };
    }

    function keydown(view: EditorView, init: KeyboardEventInit): KeyboardEvent {
      const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      view.contentDOM.dispatchEvent(ev);
      return ev;
    }

    it('emits BOLD on Mod-b and prevents default (so the global handler skips it)', () => {
      const { bus, view } = setupWithBus('hello');
      const bold = vi.fn();
      bus.on(ACTIONS.BOLD, bold);
      const ev = keydown(view, { key: 'b', ctrlKey: true });
      expect(bold).toHaveBeenCalledTimes(1);
      expect(ev.defaultPrevented).toBe(true);
    });

    it('emits ITALIC on Mod-i instead of selecting the parent syntax node', () => {
      const { bus, view } = setupWithBus('a paragraph of prose');
      const italic = vi.fn();
      bus.on(ACTIONS.ITALIC, italic);
      const before = view.state.selection.main;
      const ev = keydown(view, { key: 'i', ctrlKey: true });
      expect(italic).toHaveBeenCalledTimes(1);
      expect(ev.defaultPrevented).toBe(true);
      // defaultKeymap's Mod-i (selectParentSyntax) must NOT have widened the
      // selection — the high-precedence formatting binding won.
      const after = view.state.selection.main;
      expect(after.from).toBe(before.from);
      expect(after.to).toBe(before.to);
    });
  });

  describe('gotoLine', () => {
    it('moves the cursor to the start of the target line', () => {
      const { editor, view } = setup('one\ntwo\nthree');
      editor.gotoLine(3);
      const pos = view.state.selection.main.head;
      expect(view.state.doc.lineAt(pos).number).toBe(3);
      expect(pos).toBe(view.state.doc.line(3).from);
    });

    it('clamps a too-large line number to the last line', () => {
      const { editor, view } = setup('one\ntwo');
      editor.gotoLine(999);
      expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(2);
    });

    it('clamps a non-positive line number to the first line', () => {
      const { editor, view } = setup('one\ntwo');
      editor.gotoLine(0);
      expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(1);
    });
  });
});

describe('editor search keymap', () => {
  it('leaves Mod-Shift-g to the Changes view (no find-previous on it)', async () => {
    const { editorSearchKeymap } = await import('../editor');
    const modG = editorSearchKeymap.find((b) => b.key === 'Mod-g');
    expect(modG?.run).toBeTypeOf('function'); // find next stays
    expect(modG?.shift).toBeUndefined();
    // Find previous is still reachable on Shift-F3.
    expect(editorSearchKeymap.some((b) => b.key === 'F3' && b.shift)).toBe(true);
  });
});

describe('EditorManager input gate (hidden editor takes no input)', () => {
  it('off: read-only, blurred, formatting and focus are no-ops; on restores', () => {
    const { editor, view } = setup('hello');
    editor.focus();
    expect(view.hasFocus).toBe(true);

    editor.setInputEnabled(false);
    expect(editor.isInputEnabled()).toBe(false);
    expect(view.hasFocus).toBe(false);
    expect(view.state.readOnly).toBe(true);
    expect(view.contentDOM.getAttribute('contenteditable')).toBe('false');
    editor.focus();
    expect(view.hasFocus).toBe(false);
    select(view, 0, 5);
    editor.wrapSelection('**', '**');
    editor.insertAtCursor('x');
    editor.insertLinePrefix('# ');
    expect(editor.getContent()).toBe('hello');
    // Programmatic updates (disk reload, agent edit) still apply.
    editor.replaceContentPreservingView('from disk');
    expect(editor.getContent()).toBe('from disk');

    editor.setInputEnabled(true);
    expect(view.state.readOnly).toBe(false);
    editor.insertAtCursor('!');
    expect(editor.getContent()).toContain('!');
  });

  it('sticks across tab states (fresh and cached)', () => {
    const { editor, view } = setup('a');
    editor.saveStateFor('t1'); // cached while input was on
    editor.setInputEnabled(false);
    expect(editor.restoreStateFor('t1')).toBe(true);
    expect(view.state.readOnly).toBe(true);
    editor.loadFresh('b', 'b.md');
    expect(view.state.readOnly).toBe(true);
    editor.saveStateFor('t2'); // cached while input was off
    editor.setInputEnabled(true);
    editor.restoreStateFor('t2');
    expect(view.state.readOnly).toBe(false);
  });
});
