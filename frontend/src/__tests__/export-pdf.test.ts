// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { markPrintTarget, clearPrintTarget, waitForImages, printTarget } from '../app/export-pdf';

function layout(): { target: HTMLElement; sibling: HTMLElement } {
  document.body.innerHTML = `
    <div id="app"><div id="side"></div>
      <div id="col"><div id="editor"></div><div id="wrap"><div id="target"><p>doc</p></div></div></div>
    </div>`;
  return { target: document.getElementById('target')!, sibling: document.getElementById('editor')! };
}

afterEach(() => {
  clearPrintTarget();
  vi.useRealTimers();
});

describe('markPrintTarget', () => {
  it('marks the target and each ancestor up to <html>, nothing else', () => {
    const { target, sibling } = layout();
    markPrintTarget(target);
    expect(target.classList.contains('print-target')).toBe(true);
    const path = [...document.querySelectorAll('.print-path')].map((e) => e.id || e.tagName);
    expect(path).toEqual(['HTML', 'BODY', 'app', 'col', 'wrap']);
    expect(sibling.className).toBe('');
    expect(target.querySelector('p')!.className).toBe('');
  });

  it('moves the mark when another target is chosen', () => {
    const { target, sibling } = layout();
    markPrintTarget(target);
    markPrintTarget(sibling);
    expect(document.querySelectorAll('.print-target')).toHaveLength(1);
    expect(document.getElementById('wrap')!.classList.contains('print-path')).toBe(false);
  });
});

describe('waitForImages', () => {
  it('waits for loading images and goes on after a load or an error', async () => {
    const { target } = layout();
    const a = document.createElement('img');
    const b = document.createElement('img');
    for (const img of [a, b]) {
      img.setAttribute('src', 'asset://x.png');
      Object.defineProperty(img, 'complete', { value: false });
      target.append(img);
    }
    let settled = false;
    const wait = waitForImages(target).then(() => (settled = true));
    await Promise.resolve();
    a.dispatchEvent(new Event('load'));
    await Promise.resolve();
    expect(settled).toBe(false);
    b.dispatchEvent(new Event('error'));
    await wait;
    expect(settled).toBe(true);
  });

  it('stops waiting for an image that never finishes', async () => {
    vi.useFakeTimers();
    const { target } = layout();
    const img = document.createElement('img');
    img.setAttribute('src', 'asset://slow.png');
    Object.defineProperty(img, 'complete', { value: false });
    target.append(img);
    const wait = waitForImages(target, 500);
    vi.advanceTimersByTime(500);
    await expect(wait).resolves.toBeUndefined();
  });
});

describe('printTarget', () => {
  it('opens the dialog with the target marked and the document title set, and undoes both after printing', async () => {
    const { target } = layout();
    document.title = 'SparkDown';
    const seen: Array<{ marked: boolean; title: string }> = [];
    await printTarget(target, 'notes', async () => {
      seen.push({ marked: target.classList.contains('print-target'), title: document.title });
    });
    expect(seen).toEqual([{ marked: true, title: 'notes' }]);

    window.dispatchEvent(new Event('afterprint'));
    expect(target.classList.contains('print-target')).toBe(false);
    expect(document.title).toBe('SparkDown');
  });

  it('keeps the original title when a second export starts before the first print ends', async () => {
    const { target } = layout();
    document.title = 'SparkDown';
    await printTarget(target, 'one', async () => {});
    await printTarget(target, 'two', async () => {});
    window.dispatchEvent(new Event('afterprint'));
    expect(document.title).toBe('SparkDown');
  });

  it('undoes the marks and rethrows when the dialog cannot open', async () => {
    const { target } = layout();
    document.title = 'SparkDown';
    await expect(
      printTarget(target, 'notes', async () => {
        throw new Error('no printing');
      }),
    ).rejects.toThrow('no printing');
    expect(document.querySelectorAll('.print-target, .print-path')).toHaveLength(0);
    expect(document.title).toBe('SparkDown');
  });
});
