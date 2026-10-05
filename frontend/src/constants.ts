export const TIMING = {
  CONFIG_SAVE_MS: 2000,
  TOC_UPDATE_MS: 500,
  COUNT_UPDATE_MS: 300,
  PREVIEW_RENDER_MS: 200,
  TOC_HIDE_MS: 300,
  SCROLL_THROTTLE_MS: 16,
  FILTER_DEBOUNCE_MS: 80,
} as const;

export const LAYOUT = {
  SIDEBAR_DEFAULT_PX: 252,
  /** Minimum explorer width while dragging the sidebar divider. */
  SIDEBAR_MIN_PX: 140,
  /** Hard cap so the workspace never collapses below a usable width. */
  SIDEBAR_MAX_PX: 560,
  /** Minimum terminal drawer height while dragging. */
  TERMINAL_MIN_PX: 120,
  /** Leave this much room above the terminal for editor/preview chrome. */
  TERMINAL_TOP_RESERVE_PX: 200,
  // Explorer indentation (docs/ui-revamp/mockup.html): folder rows start at
  // BASE + depth × PER_LEVEL; nested files add NESTED_FILE_EXTRA.
  TREE_INDENT_PER_LEVEL_PX: 14,
  TREE_BASE_INDENT_PX: 8,
  TREE_NESTED_FILE_EXTRA_PX: 8,
  TREE_DRAG_THRESHOLD_PX: 5,
} as const;
