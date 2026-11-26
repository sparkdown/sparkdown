// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { saveImage, importImage } = vi.hoisted(() => ({ saveImage: vi.fn(), importImage: vi.fn() }));
vi.mock('../api', () => ({ api: { saveImage, importImage } }));

import {
  ImageInserter,
  clipboardImageFiles,
  imageMarkdown,
  isImagePath,
  pastedImageStem,
  MAX_IMAGE_BYTES,
  type ImageTarget,
} from '../image-insert';

const file = (type: string, bytes = 4) => new File([new Uint8Array(bytes)], 'f', { type });

function clipboard(files: File[], text = ''): DataTransfer {
  return {
    getData: (t: string) => (t === 'text/plain' ? text : ''),
    items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
    files,
  } as unknown as DataTransfer;
}

function harness(target: ImageTarget | null) {
  const inserted: Array<{ tabId: string; text: string; at: number | null }> = [];
  const notes: string[] = [];
  let stillActive = true;
  const inserter = new ImageInserter({
    activeTarget: () => target,
    insert: (tabId, text, at) => {
      if (!stillActive) return false;
      inserted.push({ tabId, text, at });
      return true;
    },
    notify: async (text) => {
      notes.push(text);
    },
  });
  return { inserter, inserted, notes, leave: () => (stillActive = false) };
}

const doc: ImageTarget = { tabId: 't1', path: '/docs/notes.md', origin: null };

beforeEach(() => {
  saveImage.mockReset();
  importImage.mockReset();
});

describe('image helpers', () => {
  it('recognizes the image types a document can embed', () => {
    expect(['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp'].every(isImagePath)).toBe(true);
    expect(['a.svg', 'b.md', 'png', 'c.png.txt'].some(isImagePath)).toBe(false);
  });

  it('links a file name relative to the document', () => {
    expect(imageMarkdown('shot-1.png')).toBe('![](shot-1.png)');
    expect(imageMarkdown('a b(1).png')).toBe('![](a%20b%281%29.png)');
  });

  it('names pasted images by local date and time', () => {
    expect(pastedImageStem(new Date(2026, 10, 26, 9, 5, 7))).toBe('image-20261126-090507');
  });

  it('takes image files from a paste unless it also carries text', () => {
    const img = file('image/png');
    expect(clipboardImageFiles(clipboard([img]))).toEqual([img]);
    expect(clipboardImageFiles(clipboard([img], 'some text'))).toEqual([]);
    expect(clipboardImageFiles(clipboard([file('application/pdf')]))).toEqual([]);
    expect(clipboardImageFiles(null)).toEqual([]);
  });
});

describe('ImageInserter', () => {
  it('stores each pasted image and inserts one link per line', async () => {
    saveImage.mockResolvedValueOnce('image-1.png').mockResolvedValueOnce('image-1-1.png');
    const h = harness(doc);
    await h.inserter.pasteFiles([file('image/png'), file('image/png')]);
    expect(saveImage).toHaveBeenCalledTimes(2);
    expect(saveImage.mock.calls[0][0]).toBe('/docs/notes.md');
    expect(saveImage.mock.calls[0][2]).toBe('AAAAAA==');
    expect(h.inserted).toEqual([
      { tabId: 't1', text: '![](image-1.png)\n![](image-1-1.png)', at: null },
    ]);
    expect(h.notes).toEqual([]);
  });

  it('refuses an unsaved document without writing', async () => {
    const h = harness({ ...doc, path: null });
    await h.inserter.pasteFiles([file('image/png')]);
    expect(saveImage).not.toHaveBeenCalled();
    expect(h.notes[0]).toContain('Save this document first');
  });

  it('refuses a document on a remote host', async () => {
    const h = harness({ ...doc, origin: 'dev' });
    await h.inserter.dropPaths(['/pics/a.png'], 3);
    expect(importImage).not.toHaveBeenCalled();
    expect(h.notes[0]).toContain('remote folder');
  });

  it('skips images over the size cap and reports them', async () => {
    const h = harness(doc);
    await h.inserter.pasteFiles([file('image/png', MAX_IMAGE_BYTES + 1)]);
    expect(saveImage).not.toHaveBeenCalled();
    expect(h.inserted).toEqual([]);
    expect(h.notes[0]).toContain('20 MB');
  });

  it('inserts dropped images at the drop point and reports failures', async () => {
    importImage.mockResolvedValueOnce('a.png').mockRejectedValueOnce('Only PNG, JPEG, GIF and WebP images can be added');
    const h = harness(doc);
    await h.inserter.dropPaths(['/pics/a.png', '/pics/b.png'], 7);
    expect(importImage.mock.calls).toEqual([
      ['/docs/notes.md', '/pics/a.png'],
      ['/docs/notes.md', '/pics/b.png'],
    ]);
    expect(h.inserted).toEqual([{ tabId: 't1', text: '![](a.png)', at: 7 }]);
    expect(h.notes[0]).toContain('Only PNG');
  });

  it('says where the image went when the document left the editor', async () => {
    saveImage.mockResolvedValueOnce('image-1.png');
    const h = harness(doc);
    h.leave();
    await h.inserter.pasteFiles([file('image/png')]);
    expect(h.notes[0]).toContain('Saved image-1.png');
  });

  it('only wants images for markdown documents', () => {
    expect(harness(doc).inserter.wantsImages()).toBe(true);
    expect(harness({ ...doc, path: null }).inserter.wantsImages()).toBe(true);
    expect(harness({ ...doc, path: '/a/data.json' }).inserter.wantsImages()).toBe(false);
    expect(harness(null).inserter.wantsImages()).toBe(false);
  });
});
