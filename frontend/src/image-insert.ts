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
  if (!data || pasteHasText(data)) return [];
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

/** True when a paste carries text (or a link list) for the editor's own
 *  text paste. */
export function pasteHasText(data: DataTransfer): boolean {
  return data.getData('text/plain').trim() !== '' || data.getData('text/uri-list').trim() !== '';
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

  /**
   * A paste into the editor. True when it is an image paste, which the
   * caller then keeps from the editor's text paste. A paste that carries
   * text stays a text paste.
   *
   * WebKitGTK (Linux) hands the paste event no image data: a copied image
   * arrives as a paste with no types, items or files. Such an empty paste
   * reads the image from the system clipboard through the core instead;
   * WebView2 and WKWebView put the image on the event itself.
   */
  handlePaste(data: DataTransfer | null): boolean {
    const target = this.deps.activeTarget();
    if (!data || !target || !isMarkdownFile(target.path)) return false;
    if (pasteHasText(data)) return false;
    const files = clipboardImageFiles(data);
    if (files.length > 0) {
      void this.pasteFilesInto(target, files);
    } else {
      void this.pasteSystemImage(target);
    }
    return true;
  }

  /** Clipboard image data (paste). */
  async pasteFiles(files: File[]): Promise<void> {
    const target = this.deps.activeTarget();
    if (target) await this.pasteFilesInto(target, files);
  }

  private async pasteFilesInto(target: ImageTarget, files: File[]): Promise<void> {
    if (!(await this.checkTarget(target))) return;
    const docPath = target.path!;
    const stem = pastedImageStem();
    await this.store(target, null, files, async (file) => {
      if (file.size > MAX_IMAGE_BYTES) throw tooLarge();
      return api.saveImage(docPath, stem, await blobToBase64(file));
    });
  }

  /** The system clipboard, when the paste event had no data. Its text
   *  (WebKitGTK drops the text offered next to an image too) goes in as a
   *  text paste; nothing happens when it holds neither. */
  private async pasteSystemImage(target: ImageTarget): Promise<void> {
    let got: { kind: 'image' | 'text'; data: string } | null;
    try {
      got = await api.readClipboardPaste();
    } catch (e) {
      await this.deps.notify(String(e), "Couldn't Add Image");
      return;
    }
    if (!got || !got.data) return;
    if (got.kind === 'text') {
      this.deps.insert(target.tabId, got.data, null);
      return;
    }
    if (!(await this.checkTarget(target))) return;
    const docPath = target.path!;
    const stem = pastedImageStem();
    await this.store(target, null, [got.data], (b64) => api.saveImage(docPath, stem, b64));
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
    return target && (await this.checkTarget(target)) ? target : null;
  }

  /** False (after telling the user why) when images can't go into `target`. */
  private async checkTarget(target: ImageTarget): Promise<boolean> {
    if (target.origin !== null) {
      await this.deps.notify(REMOTE_MESSAGE, 'Remote Folder');
      return false;
    }
    if (!target.path) {
      await this.deps.notify(UNSAVED_MESSAGE, 'Save Document First');
      return false;
    }
    return true;
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
