/**
 * Workspace layout: default editor+preview (+ optional terminal drawer)
 * vs terminals-only (terminal fills the center column; sidebar stays).
 */

export type WorkspaceLayout = 'editor' | 'terminals';

/** Map the persisted `terminals_only` flag to a layout mode. */
export function workspaceLayoutFromConfig(terminalsOnly: boolean | undefined | null): WorkspaceLayout {
  return terminalsOnly ? 'terminals' : 'editor';
}

/**
 * Apply (or clear) the terminals-only CSS class on `#center-column`.
 * Pure DOM helper so unit tests can cover it without booting the full App.
 */
export function applyWorkspaceLayout(root: ParentNode, layout: WorkspaceLayout): void {
  const center = root.querySelector('#center-column');
  center?.classList.toggle('terminals-only', layout === 'terminals');
}
