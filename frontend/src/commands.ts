/**
 * The command registry: every action the command palette (palette.ts) can
 * run. One flat list; features add their own entries, so the palette never
 * needs to know about them.
 *
 *   import { commands } from './commands';
 *   commands.register({
 *     id: 'terminal.splitRight',
 *     title: 'Terminal: Split right',
 *     shortcut: terminalPaneShortcut('split-right'),  // or keys: KEYBINDINGS[…]
 *     run: () => terminals.split('right'),
 *     enabled: () => terminals.isVisible(),
 *   });
 *
 * Titles are "Area: Action" in sentence case. `keys` is a Tauri accelerator
 * taken from KEYBINDINGS (shortcuts.ts) so the label cannot drift from the
 * real binding; `shortcut` is a literal label for keys that are not global
 * accelerators (e.g. "Space" inside the Changes list).
 */

import { formatShortcut } from './shortcuts';

export interface Command {
  /** Stable, unique: "area.action" (e.g. "file.save"). */
  id: string;
  /** "Area: Action", sentence case ("View: Toggle word wrap"). */
  title: string;
  /** Accelerator from KEYBINDINGS, shown formatted for the platform. */
  keys?: string;
  /** Literal shortcut label, when `keys` does not apply. */
  shortcut?: string;
  /** Extra words the fuzzy match also sees (not shown). */
  keywords?: string;
  run(): void | Promise<void>;
  /** False = shown dimmed and not runnable. Omitted = always enabled. */
  enabled?(): boolean;
}

export class CommandRegistry {
  private readonly byId = new Map<string, Command>();

  /**
   * Add commands (a later entry with the same id replaces the earlier one).
   * Returns a function that removes exactly these entries.
   */
  register(...cmds: Command[]): () => void {
    for (const c of cmds) this.byId.set(c.id, c);
    return () => {
      for (const c of cmds) if (this.byId.get(c.id) === c) this.byId.delete(c.id);
    };
  }

  get(id: string): Command | undefined {
    return this.byId.get(id);
  }

  /** All commands in registration order. */
  list(): Command[] {
    return [...this.byId.values()];
  }

  isEnabled(cmd: Command): boolean {
    try {
      return cmd.enabled ? cmd.enabled() : true;
    } catch {
      return false;
    }
  }

  /** Run a command by id if it exists and is enabled. */
  async run(id: string): Promise<boolean> {
    const cmd = this.byId.get(id);
    if (!cmd || !this.isEnabled(cmd)) return false;
    await cmd.run();
    return true;
  }

  /** The label shown on the right of a palette row ("⌘S", "Space", ""). */
  shortcutLabel(cmd: Command, mac?: boolean): string {
    if (cmd.keys) return formatShortcut(cmd.keys, mac);
    return cmd.shortcut ?? '';
  }

  /** Test hook. */
  clear(): void {
    this.byId.clear();
  }
}

/** The app's single registry. */
export const commands = new CommandRegistry();
