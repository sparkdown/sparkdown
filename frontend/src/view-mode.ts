import type { AppConfig } from './api';
import type { DefaultViewMode } from './types/DefaultViewMode';
import { isPreviewable } from './utils';

/**
 * The one view a document shows (the title bar's Edit | Split | Preview |
 * Diff control, ⌘1–⌘4). Each tab remembers its own. This replaces the old
 * separate editor / preview / diff toggles, which could combine into states
 * that made no sense (both panes hidden, a diff over a hidden editor, …).
 */
export type ViewMode = DefaultViewMode | 'diff';

/** Control order; index + 1 is the ⌘ number. */
export const VIEW_MODES: readonly ViewMode[] = ['edit', 'split', 'preview', 'diff'];

export const VIEW_LABELS: Record<ViewMode, string> = {
  edit: 'Edit',
  split: 'Split',
  preview: 'Preview',
  diff: 'Diff',
};

/** Which views a document can show right now. */
export type ViewAvailability = Record<ViewMode, boolean>;

/**
 * Views available for a document. Edit always; Split and Preview only for
 * types with a preview (markdown, HTML, SVG); Diff only for a saved file
 * with git changes.
 */
export function availableViews(path: string | null, hasChanges: boolean): ViewAvailability {
  const previewable = isPreviewable(path);
  return {
    edit: true,
    split: previewable,
    preview: previewable,
    diff: !!path && hasChanges,
  };
}

/**
 * The view a tab actually shows: its remembered mode, coerced to one its file
 * type supports (a text file remembered as Split shows Edit). A chosen Diff
 * stays even when the file becomes clean — the diff pane says so — but an
 * unsaved buffer has nothing to diff.
 */
export function effectiveView(mode: ViewMode, path: string | null): ViewMode {
  if (mode === 'diff') return path ? 'diff' : 'edit';
  if (!isPreviewable(path)) return 'edit';
  return mode;
}

/** The view new tabs open in, from config. Configs written before the view
 *  control only have preview_visible (false = the preview was hidden). */
export function defaultViewFromConfig(
  config: Pick<AppConfig, 'default_view_mode' | 'preview_visible'>,
): DefaultViewMode {
  return config.default_view_mode ?? (config.preview_visible === false ? 'edit' : 'split');
}

/** ⌘/Ctrl+digit → view, for the Windows/Linux JS twin of the menu keys. */
export function viewForDigit(key: string): ViewMode | null {
  const i = Number(key) - 1;
  return Number.isInteger(i) && i >= 0 && i < VIEW_MODES.length ? VIEW_MODES[i] : null;
}
