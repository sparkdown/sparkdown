import { describe, it, expect } from 'vitest';
import {
  MAX_PANES,
  MIN_RATIO,
  autoSplitDir,
  clampRatio,
  countPanes,
  evenLayout,
  fromPersisted,
  leaf,
  mapPanes,
  neighborPane,
  nodeAt,
  paneIds,
  removePane,
  restoreLayout,
  setRatio,
  splitPane,
  toPersisted,
  type LayoutNode,
} from '../split-layout';

/** a | (b / c) */
const threeUp = (): LayoutNode =>
  splitPane(splitPane(leaf('a'), 'a', 'b', 'row'), 'b', 'c', 'column');

describe('split-layout tree ops', () => {
  it('split: empty tree becomes the pane; splitting a leaf makes an even split after it', () => {
    expect(splitPane(null, 'x', 'a', 'row')).toEqual(leaf('a'));
    expect(splitPane(leaf('a'), 'a', 'b', 'column')).toEqual({
      type: 'split',
      dir: 'column',
      ratio: 0.5,
      a: leaf('a'),
      b: leaf('b'),
    });
  });

  it('split nests at the target only; unknown target leaves the tree as is', () => {
    const t = threeUp();
    expect(paneIds(t)).toEqual(['a', 'b', 'c']);
    expect(t).toMatchObject({ dir: 'row', a: leaf('a'), b: { dir: 'column' } });
    expect(splitPane(t, 'nope', 'z', 'row')).toBe(t);
    expect(countPanes(t)).toBe(3);
  });

  it('remove collapses the parent split into the sibling', () => {
    const t = threeUp();
    expect(removePane(t, 'b')).toEqual({
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: leaf('a'),
      b: leaf('c'),
    });
    expect(removePane(t, 'a')).toMatchObject({ type: 'split', dir: 'column' });
    expect(removePane(leaf('a'), 'a')).toBeNull();
    expect(removePane(t, 'nope')).toBe(t);
    expect(removePane(null, 'a')).toBeNull();
  });

  it('ratios: set by path, clamped, non-finite → even', () => {
    const t = threeUp();
    const r = setRatio(t, '', 0.7);
    expect((r as { ratio: number }).ratio).toBe(0.7);
    const inner = setRatio(t, 'b', 0.01);
    expect((nodeAt(inner, 'b') as { ratio: number }).ratio).toBe(MIN_RATIO);
    expect(setRatio(t, 'a', 0.3)).toEqual(t); // 'a' is a leaf
    expect(clampRatio(0.99)).toBe(1 - MIN_RATIO);
    expect(clampRatio(Number.NaN)).toBe(0.5);
    expect(nodeAt(t, 'bb')).toEqual(leaf('c'));
    expect(nodeAt(t, 'aa')).toBeNull();
  });

  it('neighbor wraps both ways; unknown current → first pane', () => {
    const t = threeUp();
    expect(neighborPane(t, 'a', 1)).toBe('b');
    expect(neighborPane(t, 'c', 1)).toBe('a');
    expect(neighborPane(t, 'a', -1)).toBe('c');
    expect(neighborPane(t, 'zzz', 1)).toBe('a');
    expect(neighborPane(null, 'a', 1)).toBeNull();
  });

  it('mapPanes renames leaves and prunes nulls', () => {
    const t = threeUp();
    expect(paneIds(mapPanes(t, (id) => id.toUpperCase()))).toEqual(['A', 'B', 'C']);
    expect(mapPanes(t, (id) => (id === 'c' ? null : id))).toMatchObject({
      dir: 'row',
      a: leaf('a'),
      b: leaf('b'),
    });
    expect(mapPanes(t, () => null)).toBeNull();
  });

  it('evenLayout gives each pane the same share', () => {
    expect(evenLayout([])).toBeNull();
    expect(evenLayout(['a'])).toEqual(leaf('a'));
    const t = evenLayout(['a', 'b', 'c', 'd'])!;
    // Share of each pane = product of ratios along its path.
    const shares: number[] = [];
    const walk = (n: LayoutNode, share: number) => {
      if (n.type === 'pane') return void shares.push(share);
      walk(n.a, share * n.ratio);
      walk(n.b, share * (1 - n.ratio));
    };
    walk(t, 1);
    for (const s of shares) expect(s).toBeCloseTo(0.25);
    expect(paneIds(t)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('autoSplitDir splits along the longer side in cells', () => {
    expect(autoSplitDir(1200, 200)).toBe('row');
    expect(autoSplitDir(500, 400)).toBe('column');
    expect(autoSplitDir(0, 0)).toBe('row');
  });
});

describe('split-layout persistence', () => {
  it('round trip: runtime ids ↔ persisted sessions', () => {
    const t = threeUp();
    const sessions: Record<string, string> = { a: 'sd-1-zsh-1', b: 'sd-1-zsh-2', c: 'sd-1-zsh-3' };
    const persisted = toPersisted(t, (id) => sessions[id])!;
    expect(persisted).toEqual({
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', session: 'sd-1-zsh-1' },
      b: {
        type: 'split',
        dir: 'column',
        ratio: 0.5,
        a: { type: 'pane', session: 'sd-1-zsh-2' },
        b: { type: 'pane', session: 'sd-1-zsh-3' },
      },
    });
    // JSON on disk and back.
    const back = fromPersisted(JSON.parse(JSON.stringify(persisted)));
    expect(back).toEqual(mapPanes(t, (id) => sessions[id]));
  });

  it('panes without a session are not persisted', () => {
    const t = threeUp();
    expect(toPersisted(t, (id) => (id === 'b' ? null : `s-${id}`))).toMatchObject({
      type: 'split',
      a: { session: 's-a' },
      b: { session: 's-c' },
    });
    expect(toPersisted(t, () => null)).toBeNull();
    expect(toPersisted(null, (id) => id)).toBeNull();
  });

  it('fromPersisted sanitizes disk input: bad nodes, ratios, duplicates, over the max', () => {
    expect(fromPersisted(null)).toBeNull();
    expect(fromPersisted('pane')).toBeNull();
    expect(fromPersisted({ type: 'hexagon' })).toBeNull();
    expect(
      fromPersisted({
        type: 'split',
        dir: 'diagonal',
        ratio: 7,
        a: { type: 'pane', session: 's1' },
        b: { type: 'pane', session: '' },
      }),
    ).toEqual(leaf('s1'));
    const t = fromPersisted({
      type: 'split',
      dir: 'diagonal',
      ratio: 7,
      a: { type: 'pane', session: 's1' },
      b: { type: 'pane', session: 's1' },
    });
    expect(t).toEqual(leaf('s1')); // duplicate dropped
    const wide = evenLayout(['s1', 's2', 's3', 's4', 's5', 's6']);
    const persisted = toPersisted(wide, (id) => id);
    const capped = fromPersisted(persisted);
    expect(paneIds(capped)).toEqual(['s1', 's2', 's3', 's4']);
    expect(countPanes(capped)).toBe(MAX_PANES);
    const odd = fromPersisted({
      type: 'split',
      dir: 'column',
      ratio: 'x',
      a: { type: 'pane', session: 'a' },
      b: { type: 'pane', session: 'b' },
    });
    expect(odd).toMatchObject({ dir: 'column', ratio: 0.5 });
  });

  it('restoreLayout: prune gone sessions, append unknown live ones, migrate when unsaved', () => {
    const saved = toPersisted(threeUp(), (id) => `s-${id}`);
    // s-b died: its column collapses into s-c.
    expect(restoreLayout(saved, ['s-a', 's-c'])).toEqual({
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: leaf('s-a'),
      b: leaf('s-c'),
    });
    // A live session the layout doesn't know is split in after the last pane.
    const grown = restoreLayout(saved, ['s-a', 's-b', 's-c', 's-new', 's-over']);
    expect(paneIds(grown)).toEqual(['s-a', 's-b', 's-c', 's-new']);
    // Nothing alive → null (caller opens a fresh shell).
    expect(restoreLayout(saved, [])).toBeNull();
    // Old config: no layout → one even row of the survivors (max 4).
    const migrated = restoreLayout(undefined, ['1', '2', '3', '4', '5']);
    expect(paneIds(migrated)).toEqual(['1', '2', '3', '4']);
    expect(migrated).toMatchObject({ type: 'split', dir: 'row' });
  });
});
