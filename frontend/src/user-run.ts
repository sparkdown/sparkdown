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
import { parseUserRunView } from './user-run-view';

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
  private fileError: string | null = null;
  /** Problems last written to the Output tab, so a reload with the same
   *  problems (for example, each time Settings opens) adds no new note. */
  private reported = '';
  private filePath: string | null = null;
  private unregister: (() => void) | null = null;
  private hookQueue: Promise<void> = Promise.resolve();
  private saveQueue: Promise<void> = Promise.resolve();
  /** Lists Settings sent that did not save as sent, with the accepted list
   *  they were based on; dropped once the accepted list changes. */
  private drafts: {
    commands?: { list: UserCommand[]; base: string };
    hooks?: { list: SaveHook[]; base: string };
  } = {};

  constructor(private readonly deps: UserRunDeps) {}

  get view(): UserRunView {
    return {
      commands: this.commands,
      save_hooks: this.hooks,
      problems: this.problems,
      file_error: this.fileError,
      path: this.filePath ?? '',
      drafts: {
        commands: this.liveDraft(this.drafts.commands, this.commands),
        save_hooks: this.liveDraft(this.drafts.hooks, this.hooks),
      },
    };
  }

  private liveDraft<T>(draft: { list: T[]; base: string } | undefined, accepted: T[]): T[] | undefined {
    return draft && draft.base === JSON.stringify(accepted) ? draft.list : undefined;
  }

  /** Load (or reload) the user-level file and refresh palette entries. */
  async load(): Promise<UserRunView> {
    try {
      this.apply(parseUserRunView(await api.loadUserRun()));
    } catch (err) {
      this.problems = [`Could not load user commands: ${String(err)}`];
      this.fileError = this.problems[0]!;
      this.commands = [];
      this.hooks = [];
      this.registerPalette();
    }
    this.reportProblems();
    return this.view;
  }

  /** Persist `commands` (keeping current hooks) and reload. */
  saveCommands(commands: UserCommand[]): Promise<UserRunView> {
    const sent = commands.map((c) => ({ ...c, argv: [...c.argv] }));
    // The other list is read when this save runs, after any save before it.
    return this.queueSave(async () => {
      await this.save({ commands: sent, save_hooks: this.hooks });
      this.drafts.commands = draftOf(sent, this.commands);
    });
  }

  /** Persist `hooks` (keeping current commands) and reload. */
  saveHooks(hooks: SaveHook[]): Promise<UserRunView> {
    const sent = hooks.map((h) => ({ ...h, argv: [...h.argv], globs: [...h.globs] }));
    return this.queueSave(async () => {
      await this.save({ commands: this.commands, save_hooks: sent });
      this.drafts.hooks = draftOf(sent, this.hooks);
    });
  }

  /** Saves run one at a time, so a commands save and a hooks save sent
   *  together (Settings flushes both on close) cannot overwrite each other. */
  private queueSave(step: () => Promise<void>): Promise<UserRunView> {
    const run = this.saveQueue.then(step);
    this.saveQueue = run.catch(() => {});
    return run.then(() => this.view);
  }

  /** Never rejects: a refused or failed write is listed with the problems. */
  private async save(file: { commands: UserCommand[]; save_hooks: SaveHook[] }): Promise<UserRunView> {
    try {
      this.apply(parseUserRunView(await api.saveUserRun(file)));
    } catch (err) {
      await this.load();
      this.problems = [`Settings could not save user-run.json: ${String(err)}`, ...this.problems];
    }
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
   *  file when that file itself was saved, then runs matching on-save hooks
   *  without blocking the save. */
  afterSave(path: string): void {
    if (this.filePath && samePath(path, this.filePath)) {
      this.hookQueue = this.hookQueue.then(() => this.load().then(() => undefined)).catch(() => {});
    }
    this.hookQueue = this.hookQueue.then(() => this.runHooksFor(path)).catch(() => {});
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

  private async runHooksFor(path: string): Promise<void> {
    if (this.deps.origin() !== LOCAL_ORIGIN) return;
    if (this.hooks.every((h) => !h.enabled)) return;
    let outcomes: RunOutcome[];
    try {
      outcomes = await api.runSaveHooks(path);
    } catch {
      // A hook-runner failure must never surface as a save failure.
      return;
    }
    if (outcomes.length === 0) return;
    let opened = false;
    for (const out of outcomes) {
      const failed = !!(out.timed_out || out.error || (out.exit_code !== null && out.exit_code !== 0));
      if (failed && !opened) {
        this.deps.showOutput();
        opened = true;
      }
      const entry = this.deps.output.start('On save', out.name, joinCommandLine(out.argv));
      this.finishOutcome(entry, out);
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
    this.fileError = view.file_error ?? null;
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
    const key = this.problems.join('\n');
    if (key === this.reported) return;
    this.reported = key;
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

/** `sent` as a draft when the saved list did not keep every entry (the
 *  backend skips, for example, a second entry with the same name). */
function draftOf<T extends { name: string }>(sent: T[], accepted: T[]): { list: T[]; base: string } | undefined {
  const names = (list: T[]) => list.map((e) => e.name.trim()).join('\n');
  return names(sent) === names(accepted) ? undefined : { list: sent, base: JSON.stringify(accepted) };
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
