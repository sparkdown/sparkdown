/**
 * Discard Changes in the Changes view (#172): the row icon, Discard All and
 * the row context menu all come here.
 *
 * 1. Remote (SSH) sessions: refused with a clear reason (the core has no
 *    remote discard yet).
 * 2. The core plans the discard from a fresh `git status` (what happens to
 *    each file: revert to the last commit, or, for a file with no committed
 *    version, move it to the Trash).
 * 3. A confirmation ALWAYS comes first. It lists every file with its action,
 *    calls out partially staged files and renames, says honestly what can
 *    and can't be recovered (reverted edits are gone; "to Trash" files sit
 *    in the system Trash until it is emptied), and names open tabs with unsaved edits: the
 *    user chooses whether to drop those buffers (default: keep them).
 * 4. After the core runs: clean tabs reload from disk (or close when their
 *    file went to the Trash); kept dirty tabs stay with their text, flagged
 *    as changed on disk. The Changes list (and so the reviewed marks and
 *    the badge) refreshes. Per-file failures are reported, not hidden.
 */
import type { DiscardItem, DiscardRequest, DiscardResult, GitActionError, GitActionResult } from './api';
import type { GitReporter } from './git-output';
import { trapFocus } from './modal';
import { escapeHtml, joinPath, normalizePathForCompare } from './utils';

export const REMOTE_DISCARD_REASON =
  "Discard isn't available in remote sessions yet. Use the terminal on the remote host.";

/** What the dialog says about recovery when a file goes to the Trash (no
 *  paths: the OS decides where its Trash lives). */
export const TRASH_NOTE =
  'Files marked “to Trash” go to the system Trash (the Recycle Bin on Windows) and stay ' +
  'there until it is emptied, so you can restore them from there.';

export interface DiscardTab {
  id: string;
  path: string | null;
  modified: boolean;
}

export interface DiscardDeps {
  isRemote(): boolean;
  preview(root: string, paths: string[]): Promise<DiscardItem[]>;
  /** Run the confirmed rows (the core refuses a row whose plan changed). */
  discard(root: string, items: DiscardRequest[]): Promise<DiscardResult>;
  /** Tabs of the active machine. */
  tabs(): DiscardTab[];
  /** Re-read a tab's file; `force` drops unsaved edits. Without `force` a
   *  tab with unsaved text is flagged instead ('conflict'); 'missing' when
   *  the file is no longer on disk (the tab is left as it was). */
  reloadTab(id: string, path: string, force: boolean): Promise<ReloadOutcome> | ReloadOutcome;
  closeTab(id: string): void;
  /** Keep a dirty tab's text, flagged as changed on disk. */
  markConflict(id: string): void;
  refresh(): Promise<void> | void;
  report: GitReporter;
  /** The confirmation (tests inject one). */
  confirm?: (items: DiscardItem[], dirty: DirtyTab[]) => Promise<DiscardChoice>;
}

export type ReloadOutcome = 'reloaded' | 'conflict' | 'missing' | 'skipped';

export interface DirtyTab {
  id: string;
  path: string;
  /** The repo-relative file it shows. */
  rel: string;
}

export interface DiscardChoice {
  ok: boolean;
  /** Drop unsaved edits in the dirty tabs (else keep them). */
  dropBuffers: boolean;
}

function isGitActionError(e: unknown): e is GitActionError {
  return !!e && typeof e === 'object' && typeof (e as GitActionError).kind === 'string';
}

/** Every repo-relative path a discard touches (renames include the source). */
export function touchedPaths(items: DiscardItem[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    out.push(it.path);
    if (it.source) out.push(it.source);
  }
  return out;
}

/** Open tabs (with unsaved edits) on the files a discard touches. */
export function dirtyTabsFor(repoRoot: string, items: DiscardItem[], tabs: DiscardTab[]): DirtyTab[] {
  const byAbs = new Map(touchedPaths(items).map((rel) => [normalizePathForCompare(joinPath(repoRoot, rel)), rel]));
  const out: DirtyTab[] = [];
  for (const t of tabs) {
    if (!t.path || !t.modified) continue;
    const rel = byAbs.get(normalizePathForCompare(t.path));
    if (rel !== undefined) out.push({ id: t.id, path: t.path, rel });
  }
  return out;
}

function actionLabel(it: DiscardItem): string {
  return it.action === 'delete' ? 'to Trash' : 'revert';
}

/** The dialog's HTML body (exported for tests). */
export function discardDialogHtml(items: DiscardItem[], dirty: DirtyTab[]): string {
  const n = items.length;
  const rows = items
    .map(
      (it) =>
        `<li class="discard-item" data-path="${escapeHtml(it.path)}" data-action="${it.action}">` +
        `<span class="discard-action discard-action-${it.action}">${actionLabel(it)}</span> ` +
        `<code class="discard-path">${escapeHtml(it.path)}</code>` +
        `<small class="discard-detail">${escapeHtml(it.detail)}</small>` +
        `</li>`,
    )
    .join('');
  const dirtyHtml =
    dirty.length === 0
      ? ''
      : `<div class="discard-dirty" role="alert">` +
        `<p><strong>${dirty.length === 1 ? 'An open tab has' : `${dirty.length} open tabs have`} unsaved edits:</strong> ` +
        dirty.map((d) => `<code>${escapeHtml(d.rel)}</code>`).join(', ') +
        `</p>` +
        `<label><input type="checkbox" class="discard-drop-buffers" /> Also drop the unsaved edits in ${dirty.length === 1 ? 'that tab' : 'those tabs'}</label>` +
        `<small>Unticked, the tabs keep your text and are marked as changed on disk.</small>` +
        `</div>`;
  return (
    `<h2 class="discard-title">Discard changes in ${n === 1 ? '1 file' : `${n} files`}?</h2>` +
    `<ul class="discard-list">${rows}</ul>` +
    dirtyHtml +
    `<p class="discard-warning">This can't be undone: reverted changes are not kept anywhere.` +
    (items.some((i) => i.action === 'delete') ? ` ${escapeHtml(TRASH_NOTE)}` : '') +
    `</p>` +
    `<div class="discard-buttons"><button type="button" class="discard-cancel">Cancel</button>` +
    `<button type="button" class="discard-ok danger">Discard</button></div>`
  );
}

/** The confirmation modal. Cancel / Escape / backdrop resolve `ok: false`. */
export function showDiscardDialog(items: DiscardItem[], dirty: DirtyTab[]): Promise<DiscardChoice> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay discard-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'settings-dialog discard-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Discard changes');
    dialog.tabIndex = -1;
    dialog.innerHTML = discardDialogHtml(items, dirty);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    const modal = trapFocus(dialog);
    const done = (ok: boolean) => {
      const drop = dialog.querySelector<HTMLInputElement>('.discard-drop-buffers')?.checked ?? false;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      modal.release();
      resolve({ ok, dropBuffers: ok && drop });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        done(false);
      }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) done(false);
    });
    dialog.querySelector('.discard-cancel')!.addEventListener('click', () => done(false));
    dialog.querySelector('.discard-ok')!.addEventListener('click', () => done(true));
    // Cancel is the safe default focus.
    dialog.querySelector<HTMLButtonElement>('.discard-cancel')!.focus();
  });
}

/** What happens to an open tab of a discarded file. */
export type TabFate = 'keep' | 'close' | 'reload' | 'reload-dropping-edits';

/**
 * A tab's fate after its file was discarded. Unsaved text is only ever
 * dropped when the user ticked "drop unsaved edits" for a tab that was
 * listed in the confirmation; a tab that became dirty after the dialog
 * opened (or was not listed) always keeps its text, flagged as changed on
 * disk, and is never closed.
 */
export function tabFate(a: { tab: DiscardTab; dirty: DirtyTab[]; dropBuffers: boolean; gone: boolean }): TabFate {
  const listed = a.dirty.some((d) => d.id === a.tab.id);
  const mayDrop = listed && a.dropBuffers;
  if (a.tab.modified && !mayDrop) return 'keep';
  if (a.gone) return 'close';
  return a.tab.modified ? 'reload-dropping-edits' : 'reload';
}

/**
 * Sync the open tabs of one repo-relative file after a discard. `gone`:
 * true / false when the core said what happened to it; null when it is
 * unknown (an error): then each tab is re-read without dropping edits, and
 * a file missing from disk is treated as gone.
 */
async function reconcileTabs(
  repoRoot: string,
  rel: string,
  deps: DiscardDeps,
  a: { dirty: DirtyTab[]; dropBuffers: boolean; gone: boolean | null },
): Promise<void> {
  const abs = normalizePathForCompare(joinPath(repoRoot, rel));
  for (const t of deps.tabs()) {
    if (!t.path || normalizePathForCompare(t.path) !== abs) continue;
    if (a.gone === null) {
      const r = await deps.reloadTab(t.id, t.path, false);
      if (r === 'missing') {
        if (t.modified) deps.markConflict(t.id);
        else deps.closeTab(t.id);
      }
      continue;
    }
    const fate = tabFate({ tab: t, dirty: a.dirty, dropBuffers: a.dropBuffers, gone: a.gone });
    if (fate === 'keep') deps.markConflict(t.id);
    else if (fate === 'close') deps.closeTab(t.id);
    else await deps.reloadTab(t.id, t.path, fate === 'reload-dropping-edits');
  }
}

function summary(r: DiscardResult): string {
  const n = r.discarded.length;
  const t = r.trashed.length;
  let s = `Discarded changes in ${n === 1 ? '1 file' : `${n} files`}`;
  if (t > 0) s += ` (${t} moved to the Trash)`;
  if (r.failed.length > 0) s += `; ${r.failed.length} failed`;
  return s;
}

/**
 * The whole flow. Returns what happened, for tests and callers.
 */
export async function runDiscard(
  repoRoot: string | null,
  paths: string[],
  deps: DiscardDeps,
): Promise<'remote' | 'empty' | 'cancelled' | 'done' | 'failed'> {
  if (!repoRoot || paths.length === 0) return 'empty';
  if (deps.isRemote()) {
    deps.report.fail('discard', { kind: 'unsupported', message: REMOTE_DISCARD_REASON, detail: '' });
    return 'remote';
  }
  let items: DiscardItem[];
  try {
    items = await deps.preview(repoRoot, paths);
  } catch (e) {
    deps.report.fail('discard', asError(e));
    await deps.refresh();
    return 'failed';
  }
  const dirty = dirtyTabsFor(repoRoot, items, deps.tabs());
  const choice = await (deps.confirm ?? showDiscardDialog)(items, dirty);
  if (!choice.ok) return 'cancelled';

  deps.report.start('discard');
  let result: DiscardResult;
  try {
    result = await deps.discard(
      repoRoot,
      items.map(({ path, action, source }) => ({ path, action, ...(source ? { source } : {}) })),
    );
  } catch (e) {
    // The core errors only when nothing changed on disk, but never trust
    // that with unsaved work: re-read every affected tab without dropping
    // anything; a file that is gone closes a clean tab, flags a dirty one.
    deps.report.fail('discard', asError(e));
    for (const it of items) {
      for (const rel of [it.path, ...(it.source ? [it.source] : [])]) {
        await reconcileTabs(repoRoot, rel, deps, { dirty: [], dropBuffers: false, gone: null });
      }
    }
    await deps.refresh();
    return 'failed';
  }

  // Tabs: for files that were discarded, or went to the Trash even though a
  // later step for them failed. A failed path that was not trashed is left
  // alone (nothing happened to it).
  const done = new Set(result.discarded);
  const trashed = new Set(result.trashed);
  for (const it of items) {
    const ok = done.has(it.path);
    if (!ok && !trashed.has(it.path)) continue;
    const gone = trashed.has(it.path) || (ok && it.action === 'delete');
    await reconcileTabs(repoRoot, it.path, deps, { dirty, dropBuffers: choice.dropBuffers, gone });
    // A rename source is back on disk only when the whole row succeeded.
    if (it.source && ok) {
      await reconcileTabs(repoRoot, it.source, deps, { dirty, dropBuffers: choice.dropBuffers, gone: false });
    }
  }

  const r: GitActionResult = { summary: summary(result), output: outputOf(result), commits: null, target: null };
  if (result.failed.length > 0) {
    deps.report.fail('discard', {
      kind: 'other',
      message: `${summary(result)}. See the details.`,
      detail: outputOf(result),
    });
  } else {
    deps.report.done('discard', r);
  }
  await deps.refresh();
  return 'done';
}

function outputOf(r: DiscardResult): string {
  const failed = r.failed.map((f) => `failed: ${f.path}: ${f.message}`).join('\n');
  return [r.output, failed].filter(Boolean).join('\n');
}

function asError(e: unknown): GitActionError {
  return isGitActionError(e) ? e : { kind: 'other', message: 'Git reported an error.', detail: String(e) };
}
