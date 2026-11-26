/**
 * User-level custom commands (and, later, on-save hooks): load the file
 * from the app config directory, register palette entries, and run them
 * into the Output tab. The opened folder is never read as config.
 */

import { api, type RunOutcome, type SaveHook, type UserCommand, type UserRunView } from './api';
import type { CommandRegistry } from './commands';
import { LOCAL_ORIGIN } from './tabs';
import { joinCommandLine, splitCommandLine, trySplitCommandLine } from './user-run-argv';
import { type UserRunOutputLog, type RunLogEntry } from './user-run-output';

export type { RunOutcome, SaveHook, UserCommand, UserRunView };
export { joinCommandLine, splitCommandLine, trySplitCommandLine };

export interface UserRunDeps {
  registry: CommandRegistry;
  /** The window's workspace folder, or null. */
  root(): string | null;
  /** Tab origin: null is this computer. */
  origin(): string | null;
  openFile(path: string): void | Promise<void>;
  /** Reveal the Output tab (drawer open, no focus steal required). */
  showOutput(): void;
  output: UserRunOutputLog;
}

const COMMAND_PREFIX = 'user.run.';

export class UserRunController {
  private commands: UserCommand[] = [];
  private hooks: SaveHook[] = [];
  private problems: string[] = [];
  private filePath: string | null = null;
  private unregister: (() => void) | null = null;
  private hookQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: UserRunDeps) {}

  get view(): UserRunView {
    return {
      commands: this.commands,
      save_hooks: this.hooks,
      problems: this.problems,
      path: this.filePath ?? '',
    };
  }

  /** Load (or reload) the user-level file and refresh palette entries. */
  async load(): Promise<UserRunView> {
    try {
      const view = await api.loadUserRun();
      this.apply(view);
    } catch (err) {
      this.problems = [`Could not load user commands: ${String(err)}`];
      this.commands = [];
      this.hooks = [];
      this.registerPalette();
    }
    this.reportProblems();
    return this.view;
  }

  /** Persist `commands` (keeping current hooks) and reload. */
  async saveCommands(commands: UserCommand[]): Promise<UserRunView> {
    const view = await api.saveUserRun({
      commands,
      save_hooks: this.hooks,
    });
    this.apply(view);
    this.reportProblems();
    return this.view;
  }

  /** Open the user-level file in the editor, creating it if needed. */
  async openConfigFile(): Promise<void> {
    if (!this.filePath) await this.load();
    if (!this.filePath) return;
    try {
      await api.readFile(this.filePath);
    } catch {
      await this.saveCommands(this.commands);
    }
    await this.deps.openFile(this.filePath);
  }

  /** After a successful SparkDown save of `path`. Reloads the user-level
   *  file when that file itself was saved. */
  afterSave(path: string): void {
    if (this.filePath && samePath(path, this.filePath)) {
      this.hookQueue = this.hookQueue.then(() => this.load().then(() => undefined)).catch(() => {});
    }
  }

  /** Run a named custom command; output appears in the Output tab. */
  async runCommand(name: string): Promise<void> {
    const cmd = this.commands.find((c) => c.name === name);
    const line = cmd ? joinCommandLine(cmd.argv) : name;
    this.deps.showOutput();
    const entry = this.deps.output.start('Command', name, line);
    try {
      const out = await api.runUserCommand(name);
      this.finishOutcome(entry, out);
    } catch (err) {
      this.deps.output.finish(entry, 'error', String(err), '');
    }
  }

  private finishOutcome(entry: RunLogEntry, out: RunOutcome): void {
    const failed = !!(out.timed_out || out.error || (out.exit_code !== null && out.exit_code !== 0));
    const message = out.error
      ? out.error
      : out.exit_code === 0 || out.exit_code === null
        ? 'Finished'
        : `Exited with code ${out.exit_code}`;
    this.deps.output.finish(entry, failed ? 'error' : 'ok', message, out.output);
  }

  private apply(view: UserRunView): void {
    this.commands = view.commands;
    this.hooks = view.save_hooks;
    this.problems = view.problems;
    this.filePath = view.path || this.filePath;
    this.registerPalette();
  }

  private registerPalette(): void {
    this.unregister?.();
    const used = new Set<string>();
    const cmds = this.commands.map((c) => {
      const name = c.name;
      let id = COMMAND_PREFIX + slug(name);
      let n = 2;
      while (used.has(id)) id = `${COMMAND_PREFIX}${slug(name)}-${n++}`;
      used.add(id);
      return {
        id,
        title: `Run: ${name}`,
        keywords: 'custom command user',
        enabled: () => this.canRun(),
        run: () => this.runCommand(name),
      };
    });
    cmds.push({
      id: 'user.openConfig',
      title: 'Preferences: Open user commands file',
      keywords: 'user-run.json custom commands hooks',
      enabled: () => true,
      run: () => this.openConfigFile(),
    });
    cmds.push({
      id: 'user.reloadConfig',
      title: 'Preferences: Reload user commands',
      keywords: 'user-run.json custom commands hooks',
      enabled: () => true,
      run: () => this.load().then(() => undefined),
    });
    this.unregister = this.deps.registry.register(...cmds);
  }

  private canRun(): boolean {
    return this.deps.root() !== null && this.deps.origin() === LOCAL_ORIGIN;
  }

  private reportProblems(): void {
    if (this.problems.length === 0) return;
    this.deps.output.note(
      'Config',
      'user-run.json',
      this.problems.length === 1
        ? this.problems[0]!
        : `${this.problems.length} entries in user-run.json were skipped.`,
      this.problems.join('\n'),
    );
  }
}

function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'command';
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const left = norm(a);
  const right = norm(b);
  return left === right || left.toLowerCase() === right.toLowerCase();
}
