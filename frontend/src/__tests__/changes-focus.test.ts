// @vitest-environment jsdom
/**
 * Opening the Changes view moves focus to its list once the list has loaded.
 * Keys typed into a text field before that (the commit message box, the
 * filter) must stay in that field.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../api', () => ({ api: {} }));

import { DiffController } from '../app/diff';
import { isTextField } from '../utils';

function setup() {
  document.body.innerHTML = `
    <div id="changes-list" tabindex="0"></div>
    <textarea id="msg"></textarea>
    <div id="editor" contenteditable="true"></div>`;
  const list = document.getElementById('changes-list')!;
  const ctx = { tabs: { activeTab: () => null } };
  const diff = new DiffController(ctx as never, {} as never);
  const d = diff as unknown as {
    dom: { list: HTMLElement };
    changesMode: boolean;
    changesView: unknown;
    showQueueInDiff(): void;
  };
  d.dom = { list };
  d.changesMode = true;
  d.changesView = { hasChanges: () => true, startFile: () => null, getRepoRoot: () => '/r' };
  return { d, list };
}

describe('Changes list focus after it loads', () => {
  it('takes focus from the editor', () => {
    const { d, list } = setup();
    document.getElementById('editor')!.focus();
    d.showQueueInDiff();
    expect(document.activeElement).toBe(list);
  });

  it('leaves focus in the commit message box while the user types', () => {
    const { d } = setup();
    const msg = document.getElementById('msg') as HTMLTextAreaElement;
    msg.focus();
    msg.value = 'Fix the';
    d.showQueueInDiff();
    expect(document.activeElement).toBe(msg);
  });
});

describe('isTextField', () => {
  it('is true for text inputs, text areas and selects only', () => {
    const el = (html: string) => {
      const box = document.createElement('div');
      box.innerHTML = html;
      return box.firstElementChild;
    };
    expect(isTextField(el('<textarea></textarea>'))).toBe(true);
    expect(isTextField(el('<input type="text">'))).toBe(true);
    expect(isTextField(el('<input>'))).toBe(true);
    expect(isTextField(el('<input type="search">'))).toBe(true);
    expect(isTextField(el('<select></select>'))).toBe(true);
    expect(isTextField(el('<input type="checkbox">'))).toBe(false);
    expect(isTextField(el('<button></button>'))).toBe(false);
    expect(isTextField(el('<div contenteditable="true"></div>'))).toBe(false);
    expect(isTextField(null)).toBe(false);
  });
});
