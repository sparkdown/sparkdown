/**
 * Export PDF: print the rendered preview through the platform print dialog,
 * whose PDF destination writes the file. The print stylesheet
 * (styles/preview.css, `@media print`) shows only the marked target and the
 * chain of ancestors that holds it, so the page prints the live preview
 * itself: Mermaid diagrams, highlighted code and resolved local images are
 * the same nodes the user sees, with no copy to keep in sync.
 */

/** Class on the element whose content prints. */
export const PRINT_TARGET = 'print-target';
/** Class on each ancestor of the target, `<html>` included. */
export const PRINT_PATH = 'print-path';

/** Longest wait for one image to finish loading before printing anyway. */
const IMAGE_WAIT_MS = 10_000;

/** Undo any earlier mark, so only one target prints. */
export function clearPrintTarget(doc: Document = document): void {
  for (const el of doc.querySelectorAll(`.${PRINT_TARGET}, .${PRINT_PATH}`)) {
    el.classList.remove(PRINT_TARGET, PRINT_PATH);
  }
}

/** Make `target` the only content a print shows. */
export function markPrintTarget(target: HTMLElement): void {
  clearPrintTarget(target.ownerDocument);
  target.classList.add(PRINT_TARGET);
  for (let el = target.parentElement; el; el = el.parentElement) {
    el.classList.add(PRINT_PATH);
  }
}

/** Resolve once every `<img>` under `root` has loaded or failed, or after
 *  `timeoutMs` per image: a missing file must not stop the export. */
export function waitForImages(root: ParentNode, timeoutMs = IMAGE_WAIT_MS): Promise<void> {
  const pending = [...root.querySelectorAll<HTMLImageElement>('img')].filter(
    (img) => img.getAttribute('src') && !img.complete,
  );
  return Promise.all(
    pending.map(
      (img) =>
        new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            img.removeEventListener('load', done);
            img.removeEventListener('error', done);
            resolve();
          };
          const timer = setTimeout(done, timeoutMs);
          img.addEventListener('load', done);
          img.addEventListener('error', done);
        }),
    ),
  ).then(() => undefined);
}

/** The page title from before an export, until that print ends. */
let titleBeforePrint: string | null = null;
/** Runs once when the current export's print ends (see printTarget). */
let afterPrintEnds: (() => void) | null = null;
/** Drops the current export's `afterprint` listener. */
let dropAfterPrint: (() => void) | null = null;

/** End an export: drop the marks and give the page its title back. */
function endPrint(doc: Document): void {
  dropAfterPrint?.();
  dropAfterPrint = null;
  clearPrintTarget(doc);
  if (titleBeforePrint !== null) doc.title = titleBeforePrint;
  titleBeforePrint = null;
  const done = afterPrintEnds;
  afterPrintEnds = null;
  done?.();
}

/**
 * End the current export now: the Linux backend's `print://ended`, sent
 * when its dialog is cancelled (no `afterprint` then) or its print is
 * done. Nothing happens when no export is pending.
 */
export function finishPrint(doc: Document = document): void {
  if (titleBeforePrint === null && afterPrintEnds === null && dropAfterPrint === null) return;
  endPrint(doc);
}

/**
 * Print `target` as `title`. The page title is what the PDF destinations
 * suggest as the file name. The marks and title stay until `afterprint`,
 * `finishPrint` or the next export: the dialog is asynchronous, and the
 * marks only apply to print media. `onEnd` runs once when that print ends
 * (a later export before then takes its place).
 */
export async function printTarget(
  target: HTMLElement,
  title: string,
  openPrintDialog: () => Promise<void>,
  onEnd?: () => void,
): Promise<void> {
  const doc = target.ownerDocument;
  const win = doc.defaultView ?? window;
  const onAfterPrint = () => endPrint(doc);

  dropAfterPrint?.();
  if (titleBeforePrint === null) titleBeforePrint = doc.title;
  afterPrintEnds = onEnd ?? null;
  markPrintTarget(target);
  doc.title = title;
  await waitForImages(target);
  win.addEventListener('afterprint', onAfterPrint, { once: true });
  dropAfterPrint = () => win.removeEventListener('afterprint', onAfterPrint);
  try {
    await openPrintDialog();
  } catch (err) {
    endPrint(doc);
    throw err;
  }
}
