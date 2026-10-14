/**
 * Recent folders across windows (#66): which recents are open in some
 * window ("open in window N"), the Ctrl/⌘-click "Open in New Window"
 * modifier, and the palette's "Open recent" commands.
 */
import { api } from '../api';
import type { Command, CommandRegistry } from '../commands';
import { parseRemoteRecent } from '../remote';
import { isMacOS } from '../utils';

export interface RecentMark {
  spec: string;
  /** 1-based window number (Window menu order), or null if not open. */
  window: number | null;
}

/** Ask the core which recents are open, and where. Never throws. */
export async function markRecents(specs: string[]): Promise<RecentMark[]> {
  if (specs.length === 0) return [];
  const numbers = await api.windowNumbersFor(specs).catch(() => specs.map(() => null));
  return specs.map((spec, i) => ({ spec, window: numbers[i] ?? null }));
}

/** The modifier that forces "Open in New Window": ⌘ on macOS, Ctrl elsewhere. */
export function wantsNewWindow(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMacOS() ? e.metaKey : e.ctrlKey;
}

/** Shortcuts-dialog label for the modifier click. */
export function newWindowClickLabel(): string {
  return isMacOS() ? '⌘ Click' : 'Ctrl+Click';
}

export function openInWindowText(n: number): string {
  return `open in window ${n}`;
}

/** Folder name (plus `ssh host`) for a recent spec. */
export function recentName(spec: string): string {
  const remote = parseRemoteRecent(spec);
  const path = remote?.path ?? spec;
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  return remote ? `${name} (${remote.host})` : name;
}

/** Palette commands: one "Open recent: …" per recent folder. */
export function recentFolderCommands(
  marks: RecentMark[],
  openFolder: (spec: string) => unknown,
): Command[] {
  return marks.map((m, i) => ({
    id: `recent.folder.${i}`,
    title: `Open recent: ${recentName(m.spec)}${m.window ? ` — ${openInWindowText(m.window)}` : ''}`,
    keywords: `folder ${m.spec}`,
    run: () => void openFolder(m.spec),
  }));
}

/** Keeps the palette's recent-folder commands current. */
export class RecentFolderCommands {
  private unregister: (() => void) | null = null;

  constructor(
    private readonly reg: CommandRegistry,
    private readonly recents: () => string[],
    private readonly openFolder: (spec: string) => unknown,
  ) {}

  async refresh(): Promise<void> {
    const marks = await markRecents(this.recents());
    this.unregister?.();
    this.unregister = this.reg.register(...recentFolderCommands(marks, this.openFolder));
  }
}
