// @vitest-environment jsdom
/**
 * The per-document view (Edit | Split | Preview | Diff): which views a file
 * can show, how a remembered view is coerced, the config default, and the
 * title bar control's rendering + clicks.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  availableViews,
  effectiveView,
  defaultViewFromConfig,
  viewForDigit,
  VIEW_MODES,
} from '../view-mode';
import { ViewControl } from '../view-control';
import { EventBus } from '../events';
import { ACTIONS } from '../event-names';

describe('availableViews', () => {
  it('markdown and other previewable files get every view; Diff needs changes', () => {
    expect(availableViews('/a/doc.md', false)).toEqual({
      edit: true,
      split: true,
      preview: true,
      diff: false,
    });
    expect(availableViews('/a/doc.md', true).diff).toBe(true);
    expect(availableViews('/a/page.html', true)).toEqual({
      edit: true,
      split: true,
      preview: true,
      diff: true,
    });
  });

  it('non-markdown text files get Edit and Diff only', () => {
    expect(availableViews('/a/main.rs', true)).toEqual({
      edit: true,
      split: false,
      preview: false,
      diff: true,
    });
    expect(availableViews('/a/data.json', false)).toEqual({
      edit: true,
      split: false,
      preview: false,
      diff: false,
    });
  });

  it('an unsaved buffer has no diff', () => {
    expect(availableViews(null, true).diff).toBe(false);
    expect(availableViews(null, true).split).toBe(true); // untitled is markdown
  });
});

describe('effectiveView', () => {
  it('coerces views the file type cannot show to Edit', () => {
    expect(effectiveView('split', '/a/main.rs')).toBe('edit');
    expect(effectiveView('preview', '/a/main.rs')).toBe('edit');
    expect(effectiveView('preview', '/a/doc.md')).toBe('preview');
  });

  it('keeps a chosen Diff for a saved file, never for an unsaved buffer', () => {
    expect(effectiveView('diff', '/a/main.rs')).toBe('diff');
    expect(effectiveView('diff', null)).toBe('edit');
  });
});

describe('defaultViewFromConfig', () => {
  it('uses the stored default', () => {
    expect(defaultViewFromConfig({ default_view_mode: 'preview', preview_visible: true })).toBe(
      'preview',
    );
  });

  it('derives it from preview_visible for configs written before the control', () => {
    expect(defaultViewFromConfig({ default_view_mode: null, preview_visible: false })).toBe('edit');
    expect(defaultViewFromConfig({ default_view_mode: null, preview_visible: true })).toBe('split');
    // Missing field entirely (very old config) → Split.
    expect(
      defaultViewFromConfig({} as { default_view_mode: null; preview_visible: boolean }),
    ).toBe('split');
  });
});

describe('viewForDigit', () => {
  it('maps 1–4 to the control order', () => {
    expect(['1', '2', '3', '4'].map(viewForDigit)).toEqual(VIEW_MODES);
    expect(viewForDigit('0')).toBeNull();
    expect(viewForDigit('5')).toBeNull();
    expect(viewForDigit('a')).toBeNull();
    expect(viewForDigit('')).toBeNull();
  });
});

describe('ViewControl', () => {
  let bus: EventBus;
  let control: ViewControl;
  const btn = (m: string) =>
    document.querySelector<HTMLButtonElement>(`#view-mode button[data-view="${m}"]`)!;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="view-mode" hidden>
        <button data-view="edit">Edit</button>
        <button data-view="split">Split</button>
        <button data-view="preview">Preview</button>
        <button data-view="diff">Diff</button>
      </div>`;
    bus = new EventBus();
    control = new ViewControl(bus);
    control.init(document.getElementById('view-mode'));
  });

  it('hides with no document and shows the pressed view', () => {
    control.render(null, null);
    expect(document.getElementById('view-mode')!.hidden).toBe(true);
    control.render('split', availableViews('/a.md', false));
    expect(document.getElementById('view-mode')!.hidden).toBe(false);
    expect(btn('split').getAttribute('aria-pressed')).toBe('true');
    expect(btn('edit').getAttribute('aria-pressed')).toBe('false');
    expect(btn('split').title).toMatch(/Edit and preview \((⌘|Ctrl\+)2\)/);
  });

  it('disables views the document cannot show and says why', () => {
    control.render('edit', availableViews('/a/main.rs', false));
    expect(btn('split').getAttribute('aria-disabled')).toBe('true');
    expect(btn('preview').getAttribute('aria-disabled')).toBe('true');
    expect(btn('diff').getAttribute('aria-disabled')).toBe('true');
    expect(btn('diff').title).toBe('No git changes in this file');
    expect(btn('preview').title).toBe('No preview for this file type');
    expect(btn('edit').getAttribute('aria-disabled')).toBe('false');
  });

  it('keeps the pressed view enabled even when it became unavailable', () => {
    // A diff whose file was committed meanwhile: still what is on screen.
    control.render('diff', availableViews('/a.md', false));
    expect(btn('diff').getAttribute('aria-disabled')).toBe('false');
  });

  it('emits SET_VIEW_MODE on click, but not for a disabled view', () => {
    const seen: string[] = [];
    bus.on(ACTIONS.SET_VIEW_MODE, ({ mode }) => seen.push(mode));
    control.render('split', availableViews('/a.md', false));
    btn('preview').click();
    btn('diff').click(); // disabled: no changes
    expect(seen).toEqual(['preview']);
  });

  it('tolerates a missing root (tests / stripped shells)', () => {
    const c = new ViewControl(bus);
    c.init(null);
    expect(() => c.render('edit', null)).not.toThrow();
    vi.restoreAllMocks();
  });
});
