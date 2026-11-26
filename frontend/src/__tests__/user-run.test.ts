// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandRegistry } from '../commands';
import { UserRunController } from '../user-run';
import { UserRunOutputLog } from '../user-run-output';
import type { RunOutcome, UserCommand, UserRunView } from '../api';

const loadUserRun = vi.fn();
const saveUserRun = vi.fn();
const runUserCommand = vi.fn();
const runSaveHooks = vi.fn();
const readFile = vi.fn();

vi.mock('../api', () => ({
  api: {
    loadUserRun: (...a: unknown[]) => loadUserRun(...a),
    saveUserRun: (...a: unknown[]) => saveUserRun(...a),
    runUserCommand: (...a: unknown[]) => runUserCommand(...a),
    runSaveHooks: (...a: unknown[]) => runSaveHooks(...a),
    readFile: (...a: unknown[]) => readFile(...a),
    userRunPath: vi.fn(),
  },
}));

const PATH = '/cfg/user-run.json';

function view(over: Partial<UserRunView> = {}): UserRunView {
  return {
    commands: [],
    save_hooks: [],
    problems: [],
    path: PATH,
    ...over,
  };
}

function setup() {
  const registry = new CommandRegistry();
  // A built-in that must survive a bad user-run file.
  registry.register({ id: 'file.save', title: 'File: Save', run: () => {} });
  const outputEl = document.createElement('div');
  const output = new UserRunOutputLog(outputEl);
  const openFile = vi.fn();
  const showOutput = vi.fn();
  let root: string | null = '/ws';
  let origin: string | null = null;
  const ctrl = new UserRunController({
    registry,
    root: () => root,
    origin: () => origin,
    openFile,
    showOutput,
    output,
  });
  return {
    ctrl,
    registry,
    output,
    outputEl,
    openFile,
    showOutput,
    setRoot: (r: string | null) => { root = r; },
    setOrigin: (o: string | null) => { origin = o; },
  };
}

describe('UserRunController', () => {
  beforeEach(() => {
    loadUserRun.mockReset();
    saveUserRun.mockReset();
    runUserCommand.mockReset();
    runSaveHooks.mockReset();
    readFile.mockReset();
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('registers valid commands in the palette and runs them into the Output tab', async () => {
    const commands: UserCommand[] = [{ name: 'Format', argv: ['prettier', '--write', '.'] }];
    loadUserRun.mockResolvedValue(view({ commands }));
    const ok: RunOutcome = {
      name: 'Format',
      argv: ['prettier', '--write', '.'],
      cwd: '/ws',
      exit_code: 0,
      timed_out: false,
      output: 'formatted',
    };
    runUserCommand.mockResolvedValue(ok);
    const { ctrl, registry, showOutput, outputEl } = setup();
    await ctrl.load();
    const cmd = registry.get('user.run.format');
    expect(cmd?.title).toBe('Run: Format');
    expect(cmd?.enabled?.()).toBe(true);
    expect(registry.get('file.save')?.title).toBe('File: Save');
    await cmd!.run();
    expect(showOutput).toHaveBeenCalled();
    expect(runUserCommand).toHaveBeenCalledWith('Format');
    expect(outputEl.textContent).toContain('formatted');
    expect(outputEl.textContent).toContain('Finished');
  });

  it('keeps the palette usable when the file is invalid or a load fails', async () => {
    loadUserRun.mockResolvedValue(view({
      commands: [{ name: 'Hello', argv: ['echo', 'hi'] }],
      problems: ['Command 2 has no name; it was ignored.'],
    }));
    const { ctrl, registry, outputEl } = setup();
    await ctrl.load();
    expect(registry.get('user.run.hello')?.title).toBe('Run: Hello');
    expect(registry.get('file.save')).toBeTruthy();
    expect(outputEl.textContent).toContain('no name');

    loadUserRun.mockRejectedValue(new Error('disk down'));
    await ctrl.load();
    expect(registry.get('user.run.hello')).toBeUndefined();
    expect(registry.get('file.save')).toBeTruthy();
    expect(registry.get('user.openConfig')).toBeTruthy();
  });

  it('disables commands when no local folder is open', async () => {
    loadUserRun.mockResolvedValue(view({
      commands: [{ name: 'Hello', argv: ['echo'] }],
    }));
    const { ctrl, registry, setRoot, setOrigin } = setup();
    await ctrl.load();
    const cmd = registry.get('user.run.hello')!;
    expect(cmd.enabled?.()).toBe(true);
    setRoot(null);
    expect(cmd.enabled?.()).toBe(false);
    setRoot('/ws');
    setOrigin('me@host');
    expect(cmd.enabled?.()).toBe(false);
  });

  it('reloads when the user-level file itself is saved', async () => {
    loadUserRun.mockResolvedValue(view({
      commands: [{ name: 'One', argv: ['echo'] }],
    }));
    const { ctrl, registry } = setup();
    await ctrl.load();
    expect(registry.get('user.run.one')).toBeTruthy();
    loadUserRun.mockResolvedValue(view({
      commands: [{ name: 'Two', argv: ['echo'] }],
    }));
    ctrl.afterSave(PATH);
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.get('user.run.two')?.title).toBe('Run: Two');
    // No hook is enabled, so the runner is not called.
    expect(runSaveHooks).not.toHaveBeenCalled();
  });

  it('runs enabled hooks after a local save and never throws when they fail', async () => {
    loadUserRun.mockResolvedValue(view({
      save_hooks: [{ name: 'Fmt', argv: ['prettier', '--write'], globs: ['*.md'], enabled: true }],
    }));
    runSaveHooks.mockResolvedValue([
      {
        name: 'Fmt',
        argv: ['prettier', '--write', '/ws/a.md'],
        cwd: '/ws',
        exit_code: 1,
        timed_out: false,
        output: 'parse error',
      } satisfies RunOutcome,
    ]);
    const { ctrl, showOutput, outputEl } = setup();
    await ctrl.load();
    ctrl.afterSave('/ws/a.md');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(runSaveHooks).toHaveBeenCalledWith('/ws/a.md');
    expect(showOutput).toHaveBeenCalled();
    expect(outputEl.textContent).toContain('parse error');
    expect(outputEl.querySelector('[data-state="error"]')).toBeTruthy();

    runSaveHooks.mockRejectedValue(new Error('runner down'));
    expect(() => ctrl.afterSave('/ws/b.md')).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });

  it('does not run hooks in a remote folder, and stays quiet when none match', async () => {
    loadUserRun.mockResolvedValue(view({
      save_hooks: [{ name: 'Fmt', argv: ['prettier', '--write'], globs: ['*.md'], enabled: true }],
    }));
    runSaveHooks.mockResolvedValue([]);
    const { ctrl, showOutput, setOrigin } = setup();
    await ctrl.load();
    setOrigin('me@host');
    ctrl.afterSave('/ws/a.md');
    await new Promise((r) => setTimeout(r, 0));
    expect(runSaveHooks).not.toHaveBeenCalled();

    setOrigin(null);
    ctrl.afterSave('/ws/a.md');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(runSaveHooks).toHaveBeenCalledWith('/ws/a.md');
    expect(showOutput).not.toHaveBeenCalled();
  });

  it('records a failed command in the Output tab', async () => {
    loadUserRun.mockResolvedValue(view({
      commands: [{ name: 'Boom', argv: ['false'] }],
    }));
    runUserCommand.mockResolvedValue({
      name: 'Boom',
      argv: ['false'],
      cwd: '/ws',
      exit_code: 1,
      timed_out: false,
      output: 'nope',
    } satisfies RunOutcome);
    const { ctrl, registry, outputEl } = setup();
    await ctrl.load();
    await registry.get('user.run.boom')!.run();
    expect(outputEl.querySelector('[data-state="error"]')).toBeTruthy();
    expect(outputEl.textContent).toContain('Exited with code 1');
    expect(outputEl.textContent).toContain('nope');
  });
});
