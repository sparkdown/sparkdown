import { api } from './api';
import { isMarkdownFile } from './utils';

/** Image files that can be dropped into a markdown document. SVG is left
 *  out: it is a document, not a picture, and opens as a text tab. */
export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;

/** Same cap as the core (images.rs MAX_IMAGE_BYTES). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function isImagePath(path: string): boolean {
  return IMAGE_EXT_RE.test(path);
}

/** Markdown for an image stored beside the document. Names from the core
 *  are plain segments; anything that would end the link is escaped. */
export function imageMarkdown(fileName: string): string {
  const target = fileName.replace(
    /[ ()<>]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
  return `![](${target})`;
}

/** File stem for a pasted image: `image-20261126-103105` (local time). */
export function pastedImageStem(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `image-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

/**
 * Image files on a paste, or [] when the paste should stay a normal text
 * paste. Copying from an office app or a web page often puts a picture of
 * the text next to the text itself; the text wins there.
 */
export function clipboardImageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  if (data.getData('text/plain').trim() !== '') return [];
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (files.length === 0) {
    for (const file of Array.from(data.files ?? [])) {
      if (file.type.startsWith('image/')) files.push(file);
    }
  }
  return files;
}

/** The base64 payload of a blob (no `data:` prefix). */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const url = String(reader.result ?? '');
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/** The document an image goes into. */
export interface ImageTarget {
  tabId: string;
  path: string | null;
  /** null = this machine (Tab.origin). */
  origin: string | null;
}

export interface ImageInsertDeps {
  /** The active tab, when it is shown in an editable editor. */
  activeTarget(): ImageTarget | null;
  /** Insert markdown into the editor of tab `tabId`: at document offset
   *  `at`, or over the selection when `at` is null. False when that tab is
   *  no longer the one in the editor. */
  insert(tabId: string, text: string, at: number | null): boolean;
  /** Tell the user why nothing was inserted. */
  notify(text: string, title: string): Promise<void>;
}

const UNSAVED_MESSAGE =
  'Save this document first. Pasted and dropped images are stored next to the document file.';
const REMOTE_MESSAGE = "Images can't be added to a document in a remote folder yet.";

/**
 * Paste or drop images into the active markdown document: each image is
 * stored beside the document (never over an existing file) and linked as
 * `![](name.ext)`.
 */
export class ImageInserter {
  constructor(private readonly deps: ImageInsertDeps) {}

  /** The active markdown document, when images can go into it. */
  wantsImages(): boolean {
    const t = this.deps.activeTarget();
    return !!t && isMarkdownFile(t.path);
  }

  /** Clipboard image data (paste). */
  async pasteFiles(files: File[]): Promise<void> {
    const target = await this.savedTarget();
    if (!target?.path) return;
    const docPath = target.path;
    const stem = pastedImageStem();
    await this.store(target, null, files, async (file) => {
      if (file.size > MAX_IMAGE_BYTES) throw tooLarge();
      return api.saveImage(docPath, stem, await blobToBase64(file));
    });
  }

  /** Image files dropped at document offset `at`. */
  async dropPaths(paths: string[], at: number | null): Promise<void> {
    const target = await this.savedTarget();
    if (!target?.path) return;
    const docPath = target.path;
    await this.store(target, at, paths, (source) => api.importImage(docPath, source));
  }

  private async savedTarget(): Promise<ImageTarget | null> {
    const target = this.deps.activeTarget();
    if (!target) return null;
    if (target.origin !== null) {
      await this.deps.notify(REMOTE_MESSAGE, 'Remote Folder');
      return null;
    }
    if (!target.path) {
      await this.deps.notify(UNSAVED_MESSAGE, 'Save Document First');
      return null;
    }
    return target;
  }

  private async store<T>(
    target: ImageTarget,
    at: number | null,
    items: T[],
    save: (item: T) => Promise<string>,
  ): Promise<void> {
    const names: string[] = [];
    const errors: string[] = [];
    // One at a time, so names taken by earlier images are seen by later ones.
    for (const item of items) {
      try {
        names.push(await save(item));
      } catch (e) {
        errors.push(String(e));
      }
    }
    if (names.length > 0) {
      const text = names.map(imageMarkdown).join('\n');
      if (!this.deps.insert(target.tabId, text, at)) {
        errors.push(`Saved ${names.join(', ')}, but the document is no longer in the editor.`);
      }
    }
    if (errors.length > 0) {
      await this.deps.notify(errors.join('\n'), "Couldn't Add Image");
    }
  }
}

function tooLarge(): string {
  return `Images larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB can't be added.`;
}
