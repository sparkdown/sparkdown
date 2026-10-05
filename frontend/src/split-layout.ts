/**
 * Terminal split layout: a binary tree of rows / columns whose leaves are
 * terminal panes. Pure functions only (no DOM, no IPC), so every tree
 * operation is unit-tested on its own. The TerminalManager keeps a tree of
 * pane ids at runtime; AppConfig persists the same shape with tmux session
 * names in the leaves (see `TerminalLayout` in src-tauri/src/config.rs).
 *
 *  - `row`: children side by side (split right, ⌘D).
 *  - `column`: children stacked (split down, ⌘⇧D).
 *  - `ratio`: the share of the first child, clamped to [MIN_RATIO, 1 - MIN_RATIO].
 */
import type { TerminalLayout } from './types/TerminalLayout';

export type SplitDir = 'row' | 'column';

export type LayoutNode =
  | { type: 'pane'; id: string }
  | { type: 'split'; dir: SplitDir; ratio: number; a: LayoutNode; b: LayoutNode };

/** Most panes the grid holds; splitting is disabled at this count. */
export const MAX_PANES = 4;
/** Smallest share a divider drag leaves to either side. */
export const MIN_RATIO = 0.15;

export function clampRatio(r: number): number {
  if (!Number.isFinite(r)) return 0.5;
  return Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, r));
}

export function leaf(id: string): LayoutNode {
  return { type: 'pane', id };
}

/** Pane ids in reading order (left→right, top→bottom). */
export function paneIds(node: LayoutNode | null): string[] {
  if (!node) return [];
  if (node.type === 'pane') return [node.id];
  return [...paneIds(node.a), ...paneIds(node.b)];
}

export function countPanes(node: LayoutNode | null): number {
  return paneIds(node).length;
}

export function hasPane(node: LayoutNode | null, id: string): boolean {
  return paneIds(node).includes(id);
}

/**
 * Split pane `target` in `dir`, putting `newId` after it (right or below)
 * with an even ratio. Unknown target: the tree is returned unchanged. An
 * empty tree becomes the single new pane.
 */
export function splitPane(
  node: LayoutNode | null,
  target: string,
  newId: string,
  dir: SplitDir,
): LayoutNode {
  if (!node) return leaf(newId);
  if (node.type === 'pane') {
    if (node.id !== target) return node;
    return { type: 'split', dir, ratio: 0.5, a: node, b: leaf(newId) };
  }
  const a = splitPane(node.a, target, newId, dir);
  const b = a === node.a ? splitPane(node.b, target, newId, dir) : node.b;
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/**
 * Remove pane `id`; its sibling takes the parent's place (the split
 * collapses). Returns null when the last pane goes.
 */
export function removePane(node: LayoutNode | null, id: string): LayoutNode | null {
  if (!node) return null;
  if (node.type === 'pane') return node.id === id ? null : node;
  const a = removePane(node.a, id);
  const b = removePane(node.b, id);
  if (!a) return b;
  if (!b) return a;
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/**
 * Map every leaf id; a leaf mapped to null is removed (and its split
 * collapses). Used to translate ids ↔ sessions and to prune dead sessions.
 */
export function mapPanes(
  node: LayoutNode | null,
  fn: (id: string) => string | null,
): LayoutNode | null {
  if (!node) return null;
  if (node.type === 'pane') {
    const id = fn(node.id);
    return id === null ? null : leaf(id);
  }
  const a = mapPanes(node.a, fn);
  const b = mapPanes(node.b, fn);
  if (!a) return b;
  if (!b) return a;
  return { ...node, a, b };
}

/** The split node at `path` ('' = root, then 'a'/'b' per level), or null. */
export function nodeAt(node: LayoutNode | null, path: string): LayoutNode | null {
  let cur = node;
  for (const step of path) {
    if (!cur || cur.type !== 'split') return null;
    cur = step === 'a' ? cur.a : cur.b;
  }
  return cur;
}

/** Set the ratio of the split at `path` (clamped). Non-split path: unchanged. */
export function setRatio(node: LayoutNode, path: string, ratio: number): LayoutNode {
  if (node.type !== 'split') return node;
  if (path === '') return { ...node, ratio: clampRatio(ratio) };
  const [step, rest] = [path[0], path.slice(1)];
  if (step === 'a') return { ...node, a: setRatio(node.a, rest, ratio) };
  if (step === 'b') return { ...node, b: setRatio(node.b, rest, ratio) };
  return node;
}

/** The pane `delta` steps from `current` in reading order, wrapping around. */
export function neighborPane(
  node: LayoutNode | null,
  current: string | null,
  delta: number,
): string | null {
  const ids = paneIds(node);
  if (ids.length === 0) return null;
  const i = current ? ids.indexOf(current) : -1;
  if (i === -1) return ids[0];
  return ids[(((i + delta) % ids.length) + ids.length) % ids.length];
}

/**
 * Lay `ids` out evenly in one row (or column): a right-leaning chain whose
 * ratios give every pane the same share. Migration of pre-split configs
 * (one tab per surviving session) goes through here.
 */
export function evenLayout(ids: string[], dir: SplitDir = 'row'): LayoutNode | null {
  if (ids.length === 0) return null;
  if (ids.length === 1) return leaf(ids[0]);
  const [first, ...rest] = ids;
  return {
    type: 'split',
    dir,
    ratio: 1 / ids.length,
    a: leaf(first),
    b: evenLayout(rest, dir)!,
  };
}

/**
 * Direction for a split that should read as "calm": along the pane's longer
 * side, measured in terminal cells (a cell is about twice as tall as wide),
 * so a wide drawer pane splits right and a tall pane splits down. Unknown
 * size (0×0, e.g. hidden) splits right.
 */
export function autoSplitDir(width: number, height: number): SplitDir {
  if (width <= 0 || height <= 0) return 'row';
  return width >= height * 2 ? 'row' : 'column';
}

/** Runtime tree (pane ids) → persisted tree (session names). Panes without a
 *  session (tmux off, or plain-shell fallback) are dropped: nothing to
 *  reattach. */
export function toPersisted(
  node: LayoutNode | null,
  sessionOf: (id: string) => string | null,
): TerminalLayout | null {
  const mapped = mapPanes(node, sessionOf);
  const conv = (n: LayoutNode): TerminalLayout =>
    n.type === 'pane'
      ? { type: 'pane', session: n.id }
      : { type: 'split', dir: n.dir, ratio: n.ratio, a: conv(n.a), b: conv(n.b) };
  return mapped ? conv(mapped) : null;
}

/**
 * Persisted tree → a sanitized tree of session names (leaf ids = sessions).
 * The value comes from disk, so it is validated: unknown shapes are dropped,
 * ratios clamped, duplicate sessions kept once, and at most MAX_PANES panes
 * survive (later ones in reading order are dropped).
 */
export function fromPersisted(raw: unknown): LayoutNode | null {
  const seen = new Set<string>();
  const walk = (n: unknown, depth: number): LayoutNode | null => {
    if (!n || typeof n !== 'object' || depth > 8) return null;
    const o = n as Record<string, unknown>;
    if (o.type === 'pane') {
      const s = o.session;
      if (typeof s !== 'string' || !s || seen.has(s) || seen.size >= MAX_PANES) return null;
      seen.add(s);
      return leaf(s);
    }
    if (o.type === 'split') {
      const dir: SplitDir = o.dir === 'column' ? 'column' : 'row';
      const a = walk(o.a, depth + 1);
      const b = walk(o.b, depth + 1);
      if (!a) return b;
      if (!b) return a;
      return { type: 'split', dir, ratio: clampRatio(Number(o.ratio)), a, b };
    }
    return null;
  };
  return walk(raw, 0);
}

/**
 * The layout to restore: the saved tree (sessions) pruned to the sessions
 * still alive, plus any live session the tree does not know (older configs
 * had no layout; a session started elsewhere) laid out after it, up to
 * MAX_PANES. `live` is expected in display order. Returns null when nothing
 * is left to reattach.
 */
export function restoreLayout(saved: unknown, live: string[]): LayoutNode | null {
  const alive = new Set(live);
  let tree = mapPanes(fromPersisted(saved), (s) => (alive.has(s) ? s : null));
  const extras = live.filter((s) => !hasPane(tree, s));
  if (!tree) return evenLayout(extras.slice(0, MAX_PANES));
  for (const s of extras) {
    if (countPanes(tree) >= MAX_PANES) break;
    const ids = paneIds(tree);
    tree = splitPane(tree, ids[ids.length - 1], s, 'row');
  }
  return tree;
}
