import { convertFileSrc } from '@tauri-apps/api/core';
import { api } from './api';

/**
 * Preview image resolution.
 *
 * Local documents: the asset-protocol scope starts empty and read_file /
 * list_directory only grant the opened file's directory or the browsed
 * folder. A file opened on its own that references `../img/x.png` needs a
 * per-file grant, so every resolved local image is passed (batched, cached)
 * to the checked `allow_preview_assets` command before its `src` is set.
 *
 * Remote documents (tab origin = SSH host): an `asset://` URL would load a
 * LOCAL file with the same path — or nothing. Their images are fetched over
 * SSH (`remote_read_image`) and shown as `data:` URLs. Never `asset://`.
 */

/** Image extensions the backend accepts (keep in sync with commands.rs). */
export const PREVIEW_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico'];

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

/** Most paths sent in one allow_preview_assets call (backend cap is 512). */
const ALLOW_BATCH = 256;
/** Remote images kept as data: URLs (oldest dropped first). */
const REMOTE_CACHE_MAX = 64;

/** Join `rel` onto `baseDir`, collapsing `.` and `..` segments. Keeps the
 *  base's separator style so Windows paths stay backslash-separated. */
export function resolveAgainst(baseDir: string, rel: string): string {
  const sep = baseDir.includes('\\') && !baseDir.includes('/') ? '\\' : '/';
  const absolute = baseDir.startsWith('/') || baseDir.startsWith('\\');
  const parts = baseDir.split(/[\\/]/).filter((p) => p !== '');
  for (const seg of rel.split(/[\\/]/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      // Never climb above a drive root ("C:") or the filesystem root.
      if (parts.length > 0 && !/^[a-z]:$/i.test(parts[parts.length - 1])) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return (absolute ? sep : '') + parts.join(sep);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Srcs the preview leaves alone: already-loadable URLs and fragments. */
export function isPassthroughSrc(src: string): boolean {
  return /^(?:data:|blob:|https?:|asset:|mailto:|#|\/\/)/i.test(src) || src.startsWith('https://asset.localhost');
}

/** Lowercase extension of `path`, or null. */
export function imageExt(path: string): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Filesystem path an `<img src>` refers to, or null when it is not a file
 * reference (URL, fragment) or is relative with no base directory.
 * Drops `?query` / `#fragment` and percent-decodes (`a%20b.png`).
 */
export function resolveImagePath(src: string, baseDir: string | null): string | null {
  const raw = src.trim();
  if (raw === '' || isPassthroughSrc(raw)) return null;
  if (/^[a-z][a-z0-9+.-]+:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) return null; // other scheme
  const path = safeDecode(raw.replace(/[?#].*$/, ''));
  if (path === '') return null;
  if (path.startsWith('/')) return resolveAgainst('/', path);
  if (/^[a-z]:[\\/]/i.test(path)) return path;
  if (!baseDir) return null;
  return resolveAgainst(baseDir, path);
}

/** Base64-encode bytes into a `data:` URL (chunked; no FileReader). */
export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

export interface PreviewImageBackend {
  allowPreviewAssets(paths: string[]): Promise<boolean[]>;
  remoteReadImage(host: string, path: string): Promise<ArrayBuffer | Uint8Array | number[]>;
}

export class PreviewImageResolver {
  /** Local image paths the backend has granted (success only; failures retry). */
  private allowed = new Set<string>();
  /** `host\0path` -> data: URL (null = fetch failed). */
  private remoteCache = new Map<string, Promise<string | null>>();
  /** The resolution each <img> is waiting for; a newer one wins. */
  private pending = new WeakMap<HTMLImageElement, string>();
  private work: Promise<void> = Promise.resolve();

  constructor(
    private backend: PreviewImageBackend = api,
    private toAssetUrl: (path: string) => string = convertFileSrc,
  ) {}

  /** Forget remote images so the next render refetches (edited on host). */
  resetRemoteCache(): void {
    this.remoteCache.clear();
  }

  /** Resolves when every resolution started so far has settled. */
  idle(): Promise<void> {
    return this.work;
  }

  /**
   * Rewrite the `src` of each file-referencing image. `origin` is the
   * document's machine: null = local, otherwise the SSH host alias.
   * Images wait with no `src` until their URL is ready, so a remote image
   * never loads a same-named local file in the meantime.
   */
  resolve(images: HTMLImageElement[], baseDir: string | null, origin: string | null): Promise<void> {
    const local: Array<[HTMLImageElement, string]> = [];
    const remote: Array<[HTMLImageElement, string]> = [];
    for (const img of images) {
      const src = img.getAttribute('src');
      if (!src) continue;
      const path = resolveImagePath(src, baseDir);
      if (!path) continue;
      img.dataset.originalSrc = src;
      if (origin === null && this.allowed.has(path)) {
        this.pending.delete(img);
        img.src = this.toAssetUrl(path);
        continue;
      }
      img.removeAttribute('src');
      this.pending.set(img, `${origin ?? ''}\0${path}`);
      (origin === null ? local : remote).push([img, path]);
    }
    const tasks: Promise<void>[] = [];
    if (local.length > 0) tasks.push(this.resolveLocal(local));
    if (remote.length > 0 && origin !== null) tasks.push(this.resolveRemote(remote, origin));
    const done = Promise.all(tasks).then(() => {});
    this.work = Promise.all([this.work, done]).then(() => {});
    return done;
  }

  /** Grant + asset URL for one local path (HTML documents use this). */
  async localUrl(path: string): Promise<string> {
    await this.allow([path]);
    return this.toAssetUrl(path);
  }

  /** data: URL for one remote image, or null when it can't be read. */
  remoteUrl(host: string, path: string): Promise<string | null> {
    const key = `${host}\0${path}`;
    let hit = this.remoteCache.get(key);
    if (!hit) {
      hit = this.fetchRemote(host, path);
      this.remoteCache.set(key, hit);
      while (this.remoteCache.size > REMOTE_CACHE_MAX) {
        const oldest = this.remoteCache.keys().next().value as string;
        this.remoteCache.delete(oldest);
      }
      // A failure is not cached: the file may appear later.
      void hit.then((url) => {
        if (url === null && this.remoteCache.get(key) === hit) this.remoteCache.delete(key);
      });
    }
    return hit;
  }

  private async fetchRemote(host: string, path: string): Promise<string | null> {
    const ext = imageExt(path);
    if (!ext || !MIME[ext]) return null;
    try {
      const buf = await this.backend.remoteReadImage(host, path);
      const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf as ArrayBuffer);
      return bytesToDataUrl(bytes, MIME[ext]);
    } catch {
      return null;
    }
  }

  private async allow(paths: string[]): Promise<void> {
    const need = [...new Set(paths)].filter((p) => !this.allowed.has(p));
    for (let i = 0; i < need.length; i += ALLOW_BATCH) {
      const batch = need.slice(i, i + ALLOW_BATCH);
      try {
        const flags = await this.backend.allowPreviewAssets(batch);
        batch.forEach((p, j) => {
          if (flags[j]) this.allowed.add(p);
        });
      } catch {
        // Leave them un-granted; a directory grant may still cover them.
      }
    }
  }

  private async resolveLocal(items: Array<[HTMLImageElement, string]>): Promise<void> {
    await this.allow(items.map(([, p]) => p));
    for (const [img, path] of items) {
      if (this.pending.get(img) !== `\0${path}`) continue;
      this.pending.delete(img);
      img.src = this.toAssetUrl(path);
    }
  }

  private async resolveRemote(items: Array<[HTMLImageElement, string]>, host: string): Promise<void> {
    await Promise.all(
      items.map(async ([img, path]) => {
        const url = await this.remoteUrl(host, path);
        if (this.pending.get(img) !== `${host}\0${path}`) return;
        this.pending.delete(img);
        if (url) img.src = url;
      }),
    );
  }
}
