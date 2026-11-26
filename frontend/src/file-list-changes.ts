import type { FsChange } from './api';
import { basename } from './utils';

/**
 * Whether a batch of watcher changes can change the workspace file list.
 * Same rule as the backend cache (file_index.rs): only a structural change
 * (not a content write), or a changed `.gitignore`, alters which files are
 * listed. Quick open and the wiki-link index both use it, so `[[...]]`
 * resolves against the same files Quick open shows.
 */
export function changesFileList(changes: readonly FsChange[]): boolean {
  return changes.some((c) => c.kind !== 'modify' || basename(c.path) === '.gitignore');
}
