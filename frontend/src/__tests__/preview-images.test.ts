// @vitest-environment jsdom
/** Preview image resolution: per-file asset grants for local documents,
 *  SSH-fetched data: URLs for remote ones (never asset://). */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => {
  throw new Error(`unmocked ${String(_args[0])}`);
});
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
}));

import { PreviewPane } from '../preview';
import { EventBus } from '../events';
import {
  PreviewImageResolver,
  bytesToDataUrl,
  resolveImagePath,
  type PreviewImageBackend,
} from '../preview-images';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function backendMock(): PreviewImageBackend & {
  allowPreviewAssets: ReturnType<typeof vi.fn>;
  remoteReadImage: ReturnType<typeof vi.fn>;
} {
  return {
    allowPreviewAssets: vi.fn(async (paths: string[]) => paths.map(() => true)),
    remoteReadImage: vi.fn(async () => PNG.buffer.slice(0)),
  };
}

function img(src: string): HTMLImageElement {
  const el = document.createElement('img');
  el.setAttribute('src', src);
  document.body.appendChild(el);
  return el;
}

describe('resolveImagePath', () => {
  it('resolves relative, parent and absolute paths; skips URLs', () => {
    expect(resolveImagePath('../img/x.png', '/docs/notes')).toBe('/docs/img/x.png');
    expect(resolveImagePath('./a%20b.png?raw=1#frag', '/d')).toBe('/d/a b.png');
    expect(resolveImagePath('/abs/../y.png', null)).toBe('/y.png');
    expect(resolveImagePath('C:\\pics\\z.png', null)).toBe('C:\\pics\\z.png');
    expect(resolveImagePath('rel.png', null)).toBeNull();
    for (const url of ['https://x/y.png', 'data:image/png;base64,AA', 'asset://localhost/a', 'blob:x', '//cdn/x.png', '#x', 'javascript:alert(1)']) {
      expect(resolveImagePath(url, '/d')).toBeNull();
    }
  });

  it('bytesToDataUrl base64-encodes', () => {
    expect(bytesToDataUrl(new Uint8Array([104, 105]), 'image/png')).toBe('data:image/png;base64,aGk=');
  });
});

describe('PreviewImageResolver', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('local: grants each image once (batched), then sets an asset URL', async () => {
    const b = backendMock();
    const r = new PreviewImageResolver(b, (p) => `asset:${p}`);
    const a = img('../img/x.png');
    const c = img('../img/x.png');
    const d = img('y.png');
    await r.resolve([a, c, d], '/docs/notes', null);
    expect(b.allowPreviewAssets).toHaveBeenCalledTimes(1);
    expect(b.allowPreviewAssets).toHaveBeenCalledWith(['/docs/img/x.png', '/docs/notes/y.png']);
    expect(a.getAttribute('src')).toBe('asset:/docs/img/x.png');
    expect(c.getAttribute('src')).toBe('asset:/docs/img/x.png');
    expect(a.dataset.originalSrc).toBe('../img/x.png');

    // Already granted: set synchronously, no second IPC.
    const e = img('../img/x.png');
    await r.resolve([e], '/docs/notes', null);
    expect(b.allowPreviewAssets).toHaveBeenCalledTimes(1);
    expect(e.getAttribute('src')).toBe('asset:/docs/img/x.png');
  });

  it('local: a refused grant is retried on a later render', async () => {
    const b = backendMock();
    b.allowPreviewAssets.mockResolvedValueOnce([false]);
    const r = new PreviewImageResolver(b, (p) => `asset:${p}`);
    await r.resolve([img('/a.png')], null, null);
    await r.resolve([img('/a.png')], null, null);
    expect(b.allowPreviewAssets).toHaveBeenCalledTimes(2);
  });

  it('remote: fetches over SSH as data: URLs, never asset://, and caches', async () => {
    const b = backendMock();
    const toAsset = vi.fn((p: string) => `asset:${p}`);
    const r = new PreviewImageResolver(b, toAsset);
    const a = img('../img/x.png');
    const c = img('../img/x.png');
    const pending = r.resolve([a, c], '/home/u/docs', 'devbox');
    // While in flight the image has no src: nothing local may load.
    expect(a.hasAttribute('src')).toBe(false);
    await pending;
    expect(b.remoteReadImage).toHaveBeenCalledTimes(1);
    expect(b.remoteReadImage).toHaveBeenCalledWith('devbox', '/home/u/img/x.png');
    expect(a.getAttribute('src')).toBe(bytesToDataUrl(PNG, 'image/png'));
    expect(c.getAttribute('src')).toBe(a.getAttribute('src'));
    expect(b.allowPreviewAssets).not.toHaveBeenCalled();
    expect(toAsset).not.toHaveBeenCalled();

    r.resetRemoteCache();
    await r.resolve([img('../img/x.png')], '/home/u/docs', 'devbox');
    expect(b.remoteReadImage).toHaveBeenCalledTimes(2);
  });

  it('remote: a failed fetch leaves no src and is not cached', async () => {
    const b = backendMock();
    b.remoteReadImage.mockRejectedValueOnce('no remote session');
    const r = new PreviewImageResolver(b, (p) => `asset:${p}`);
    const a = img('x.png');
    await r.resolve([a], '/h', 'devbox');
    expect(a.hasAttribute('src')).toBe(false);
    const c = img('x.png');
    await r.resolve([c], '/h', 'devbox');
    expect(c.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  });

  it('remote: non-image extensions are never requested', async () => {
    const b = backendMock();
    const r = new PreviewImageResolver(b, (p) => `asset:${p}`);
    const a = img('../../.ssh/id_rsa');
    await r.resolve([a], '/home/u/docs', 'devbox');
    expect(b.remoteReadImage).not.toHaveBeenCalled();
    expect(a.hasAttribute('src')).toBe(false);
  });
});

describe('PreviewPane image wiring', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    invoke.mockReset();
  });

  async function render(md: string, baseDir: string | null, origin: string | null) {
    const pane = new PreviewPane(new EventBus());
    const container = document.createElement('div');
    document.body.appendChild(container);
    pane.init(container);
    pane.setRenderMode('notes.md');
    pane.setOriginResolver(() => origin);
    if (baseDir) pane.setBaseDir(baseDir);
    await pane.renderImmediateForExport(md);
    await pane.whenImagesResolved();
    return container;
  }

  it('a lone local file with ../img asks allow_preview_assets for that exact file', async () => {
    invoke.mockImplementation(async (cmd: unknown, args: unknown) => {
      if (cmd === 'allow_preview_assets') return (args as { paths: string[] }).paths.map(() => true);
      throw new Error(`unmocked ${String(cmd)}`);
    });
    const c = await render('![x](../img/x.png)', '/Users/me/notes', null);
    expect(invoke).toHaveBeenCalledWith('allow_preview_assets', { paths: ['/Users/me/img/x.png'] });
    expect(c.querySelector('img')!.getAttribute('src')).toBe(
      `asset://localhost/${encodeURIComponent('/Users/me/img/x.png')}`,
    );
  });

  it('a remote tab fetches images with remote_read_image and never uses asset://', async () => {
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === 'remote_read_image') return PNG.buffer.slice(0);
      throw new Error(`unmocked ${String(cmd)}`);
    });
    const c = await render('![x](../img/x.png)\n\n![y](/abs/y.svg)', '/home/u/notes', 'devbox');
    expect(invoke).toHaveBeenCalledWith('remote_read_image', { host: 'devbox', path: '/home/u/img/x.png' });
    expect(invoke).toHaveBeenCalledWith('remote_read_image', { host: 'devbox', path: '/abs/y.svg' });
    expect(invoke).not.toHaveBeenCalledWith('allow_preview_assets', expect.anything());
    const srcs = Array.from(c.querySelectorAll('img')).map((i) => i.getAttribute('src') ?? '');
    expect(srcs[0]).toMatch(/^data:image\/png;base64,/);
    expect(srcs[1]).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(srcs.some((s) => s.startsWith('asset:'))).toBe(false);
  });
});
