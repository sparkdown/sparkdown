// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachResizeDrag } from '../resize-drag';

describe('attachResizeDrag', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    document.body.className = '';
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  it('locks selection and pointer targets while dragging, then clears on mouseup', () => {
    const handle = document.createElement('div');
    document.body.appendChild(handle);
    const onStart = vi.fn();
    const onMove = vi.fn();
    const onEnd = vi.fn();

    attachResizeDrag(handle, { cursor: 'row-resize', onStart, onMove, onEnd });

    handle.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(document.body.classList.contains('is-resizing')).toBe(true);
    expect(handle.classList.contains('is-active')).toBe(true);
    expect(document.body.style.userSelect).toBe('none');
    expect(document.body.style.cursor).toBe('row-resize');

    const selectStart = new Event('selectstart', { cancelable: true });
    document.dispatchEvent(selectStart);
    expect(selectStart.defaultPrevented).toBe(true);

    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 40, bubbles: true }));
    expect(onMove).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(document.body.classList.contains('is-resizing')).toBe(false);
    expect(handle.classList.contains('is-active')).toBe(false);
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('ignores non-primary mouse buttons', () => {
    const handle = document.createElement('div');
    document.body.appendChild(handle);
    const onStart = vi.fn();
    attachResizeDrag(handle, { cursor: 'col-resize', onStart, onMove: () => {} });
    handle.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true, cancelable: true }));
    expect(onStart).not.toHaveBeenCalled();
    expect(document.body.classList.contains('is-resizing')).toBe(false);
  });

  it('prevents default on mousedown so text selection cannot begin', () => {
    const handle = document.createElement('div');
    document.body.appendChild(handle);
    attachResizeDrag(handle, { cursor: 'row-resize', onMove: () => {} });
    const ev = new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true });
    handle.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
});
