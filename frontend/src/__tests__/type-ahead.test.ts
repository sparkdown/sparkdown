// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { TypeAhead } from '../type-ahead';

describe('TypeAhead', () => {
  let host: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="host"></div><textarea id="editor"></textarea>';
    host = document.getElementById('host')!;
    document.getElementById('editor')!.focus();
  });

  it('takes focus from the editor and gives back what was typed, Enter as CR', () => {
    const ahead = new TypeAhead(() => host);
    ahead.start();
    const box = host.querySelector('textarea')!;
    expect(document.activeElement).toBe(box);
    box.value = 'echo e\nls -l\n';
    expect(ahead.take()).toBe('echo e\rls -l\r');
    expect(host.querySelector('textarea')).toBeNull();
    expect((document.getElementById('editor') as HTMLTextAreaElement).value).toBe('');
  });

  it('keeps Tab as a character instead of moving focus', () => {
    const ahead = new TypeAhead(() => host);
    ahead.start();
    const box = host.querySelector('textarea')!;
    box.value = 'ls';
    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    box.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(ahead.take()).toBe('ls\t');
  });

  it('start twice keeps one box; discard drops the text; take without a box is empty', () => {
    const ahead = new TypeAhead(() => host);
    expect(ahead.take()).toBe('');
    ahead.start();
    ahead.start();
    expect(host.querySelectorAll('textarea')).toHaveLength(1);
    host.querySelector('textarea')!.value = 'x';
    ahead.discard();
    expect(host.querySelector('textarea')).toBeNull();
    expect(ahead.take()).toBe('');
  });

  it('does nothing when there is no host', () => {
    const ahead = new TypeAhead(() => null);
    ahead.start();
    expect(document.activeElement?.id).toBe('editor');
  });
});
