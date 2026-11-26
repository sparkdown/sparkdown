/**
 * Copy for the Accept ours / Accept theirs confirmation. Pure, so tests
 * can check the wording (especially delete/modify and rebase).
 */

export type ConflictSide = 'ours' | 'theirs';

/** What accepting `side` will do to the working tree, in one short line. */
export function acceptConflictAction(kind: string | undefined, side: ConflictSide): string {
  switch (kind) {
    case 'deleted-by-us':
      return side === 'ours' ? 'This will delete the file (our side removed it).' : 'This will keep their version of the file.';
    case 'deleted-by-them':
      return side === 'theirs' ? 'This will delete the file (their side removed it).' : 'This will keep our version of the file.';
    case 'added-by-us':
      return side === 'theirs' ? 'This will delete the file (only our side added it).' : 'This will keep the file we added.';
    case 'added-by-them':
      return side === 'ours' ? 'This will delete the file (only their side added it).' : 'This will keep the file they added.';
    case 'both-deleted':
      return 'Both sides deleted this file. This will mark the deletion resolved.';
    case 'both-added':
      return side === 'ours' ? 'Both sides added this file. This will keep our version.' : 'Both sides added this file. This will keep their version.';
    default:
      return side === 'ours' ? 'This will keep our version of the file and drop theirs.' : 'This will keep their version of the file and drop ours.';
  }
}

export function acceptConflictPrompt(opts: {
  path: string;
  side: ConflictSide;
  kind?: string;
  operation?: string | null;
}): { title: string; message: string; okLabel: string } {
  const name = opts.path.split('/').pop() ?? opts.path;
  const okLabel = opts.side === 'ours' ? 'Accept ours' : 'Accept theirs';
  const title = `${okLabel} — ${name}`;
  const lines: string[] = [acceptConflictAction(opts.kind, opts.side)];
  if (opts.operation === 'rebase') {
    lines.push(
      'During a rebase, ours is the branch you are rebasing onto, and theirs is the commit being replayed.',
    );
  } else if (opts.operation === 'merge') {
    lines.push('Ours is this branch; theirs is the incoming branch.');
  }
  lines.push('A copy of the current file is kept in the Trash so you can restore it.');
  return { title, message: lines.join('\n\n'), okLabel };
}

/** Open a conflicted file in the editor so conflict markers are visible. */
export function openHowFor(status: string): 'diff' | 'editor' {
  return status === 'conflicted' ? 'editor' : 'diff';
}
