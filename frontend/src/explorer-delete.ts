/**
 * Explorer → Delete (#121). Ask first, naming the item; locally it goes to the
 * OS trash (the backend never falls back to a permanent delete), on a remote
 * host it is removed for good and the prompt says so. Afterwards: clean tabs
 * of the deleted path (or anything under a deleted folder) close; tabs with
 * unsaved edits stay open with their text, so nothing typed is lost.
 */
import { basename, normalizePathForCompare } from './utils';

export type DeleteOutcome = 'trashed' | 'deleted';

export interface DeleteTab {
  id: string;
  path: string | null;
  modified: boolean;
}

export interface DeleteDeps {
  ask: (message: string, opts: { title: string; kind: 'warning'; okLabel: string; cancelLabel: string }) => Promise<boolean>;
  deletePath: (path: string) => Promise<DeleteOutcome>;
  /** Tabs of this window's machine (same origin as the tree). */
  tabs: () => DeleteTab[];
  closeTab: (id: string) => void;
  /** Mark a kept dirty tab: its file is gone, saving writes it again. */
  markGone: (id: string) => void;
  refresh: () => Promise<void> | void;
  showError: (message: string) => void;
}

export function deletePrompt(path: string, isDir: boolean, remote: boolean): string {
  const what = isDir ? `the folder “${basename(path)}” and everything in it` : `“${basename(path)}”`;
  return remote
    ? `Delete ${what}?\n\nThis is a remote folder, so it can't go to the Trash. It will be deleted permanently.`
    : `Move ${what} to the Trash?\n\nYou can restore it from the Trash.`;
}

/** Tabs showing `path`, or a file under it when it is a folder. */
export function tabsUnder<T extends DeleteTab>(tabs: T[], path: string, isDir: boolean): T[] {
  const target = normalizePathForCompare(path).replace(/\/+$/, '');
  return tabs.filter((t) => {
    if (!t.path) return false;
    const p = normalizePathForCompare(t.path);
    return p === target || (isDir && p.startsWith(`${target}/`));
  });
}

export async function deleteEntry(
  entry: { path: string; isDir: boolean },
  remote: boolean,
  deps: DeleteDeps,
): Promise<'cancelled' | DeleteOutcome | 'failed'> {
  const ok = await deps.ask(deletePrompt(entry.path, entry.isDir, remote), {
    title: remote ? 'Delete permanently' : 'Move to Trash',
    kind: 'warning',
    okLabel: remote ? 'Delete' : 'Move to Trash',
    cancelLabel: 'Cancel',
  });
  if (!ok) return 'cancelled';
  let outcome: DeleteOutcome;
  try {
    outcome = await deps.deletePath(entry.path);
  } catch (e) {
    deps.showError(`Couldn't delete “${basename(entry.path)}”: ${String(e)}`);
    return 'failed';
  }
  for (const t of tabsUnder(deps.tabs(), entry.path, entry.isDir)) {
    if (t.modified) deps.markGone(t.id);
    else deps.closeTab(t.id);
  }
  await deps.refresh();
  return outcome;
}
