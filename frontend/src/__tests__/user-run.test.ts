// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandRegistry } from '../commands';
import { UserRunController } from '../user-run';
import { UserRunOutputLog } from '../user-run-output';
import type { AppConfig, RunOutcome, UserCommand, UserRunView } from '../api';
import { SettingsDialog } from '../settings-dialog';
import { parseUserRunView } from '../user-run-view';

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
    detectAgents: vi.fn(async () => []),
    mcpShimCommand: vi.fn(async () => null),
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

  function openSettings(ctrl: UserRunController) {
    const dialog = new SettingsDialog();
    const config = { use_tmux: false, agent_context_enabled: false } as AppConfig;
    dialog.toggle({
      config,
      onChange: () => {},
      userRun: {
        view: () => ctrl.view,
        saveCommands: async (c) => { await ctrl.saveCommands(c); },
        saveHooks: async (h) => { await ctrl.saveHooks(h); },
        openFile: () => {},
        reload: async () => { await ctrl.load(); },
      },
    });
    return dialog;
  }

  it('opens Settings for a hook the backend sent without globs', async () => {
    // What the 0.4.7 backend returned after Settings added a hook with no
    // file filter: `globs` left out of the hook.
    loadUserRun.mockResolvedValue({
      commands: [],
      save_hooks: [{ name: 'New hook', argv: ['echo'], enabled: false }],
      problems: [],
      path: PATH,
    });
    const { ctrl } = setup();
    await ctrl.load();
    expect(ctrl.view.save_hooks[0]?.globs).toEqual([]);
    const dialog = openSettings(ctrl);
    expect(dialog.isOpen).toBe(true);
    const hooks = document.querySelector('[data-section="hooks"]')!;
    expect(hooks.querySelectorAll('.settings-run-item')).toHaveLength(1);
    expect(hooks.querySelector<HTMLInputElement>('input[data-run-field="hook-globs"]')!.value).toBe('');
    dialog.close();
  });

  it('opens Settings read-only with the error when the file is not valid JSON', async () => {
    const err = 'user-run.json is not valid JSON: EOF while parsing an object at line 1 column 20';
    loadUserRun.mockResolvedValue(view({ problems: [err], file_error: err }));
    const { ctrl, registry, outputEl } = setup();
    await ctrl.load();
    expect(registry.get('user.openConfig')).toBeTruthy();
    expect(outputEl.textContent).toContain('not valid JSON');
    const dialog = openSettings(ctrl);
    expect(dialog.isOpen).toBe(true);
    const notice = document.querySelector<HTMLElement>('[data-run-notice]')!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain('not valid JSON');
    const open = [...notice.querySelectorAll('button')].find((b) => b.textContent === 'Open user-run.json')!;
    expect(open.disabled).toBe(false);
    const add = [...document.querySelectorAll<HTMLButtonElement>('[data-section="hooks"] button')]
      .find((b) => b.textContent === 'Add hook')!;
    expect(add.disabled).toBe(true);
    dialog.close();
  });

  it('a refused save is listed, not thrown', async () => {
    loadUserRun.mockResolvedValue(view());
    saveUserRun.mockRejectedValue('user-run.json is not valid JSON. Fix user-run.json in the editor first; Settings did not change it.');
    const { ctrl, outputEl } = setup();
    await ctrl.load();
    const out = await ctrl.saveHooks([{ name: 'H', argv: ['echo'], globs: [], enabled: false }]);
    expect(out.problems[0]).toContain('Settings could not save user-run.json');
    expect(outputEl.textContent).toContain('Settings could not save');
  });

  it('notes the same problems in the Output tab once, across reloads', async () => {
    loadUserRun.mockResolvedValue(view({ problems: ['Command 4 has no name; it was skipped.'] }));
    const { ctrl, output } = setup();
    await ctrl.load();
    await ctrl.load();
    expect(output.all()).toHaveLength(1);
    loadUserRun.mockResolvedValue(view({ problems: ['Command 5 has no name; it was skipped.'] }));
    await ctrl.load();
    expect(output.all()).toHaveLength(2);
  });

  it('Settings lists an entry added on disk after launch when it opens', async () => {
    loadUserRun.mockResolvedValue(view({ commands: [{ name: 'Hello', argv: ['echo'] }] }));
    const { ctrl } = setup();
    await ctrl.load();
    loadUserRun.mockResolvedValue(view({
      commands: [{ name: 'Hello', argv: ['echo'] }],
      problems: ['Command 2 has no name; it was skipped.'],
    }));
    const dialog = openSettings(ctrl);
    await new Promise((r) => setTimeout(r, 0));
    const notice = document.querySelector<HTMLElement>('[data-run-notice]')!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain('Command 2 has no name');
    dialog.close();
  });
});

describe('parseUserRunView', () => {
  const PATH2 = '/cfg/user-run.json';
  const ok = { name: 'Ok', argv: ['echo'] };
  const cases: [string, unknown, string][] = [
    ['commands', { argv: ['a'] }, 'no name'],
    ['commands', { name: '', argv: ['a'] }, 'no name'],
    ['commands', { name: 7, argv: ['a'] }, 'no name'],
    ['commands', { name: 'X', argv: [] }, 'argv'],
    ['commands', { name: 'X', argv: 'echo hi' }, 'argv'],
    ['commands', { name: 'X', argv: ['a', 1] }, 'argv'],
    ['commands', { name: 'X', argv: ['a'], timeout_ms: '5' }, 'timeout_ms'],
    ['commands', 'text', 'not an object'],
    ['save_hooks', { name: 'H', argv: ['a'], globs: '*.md' }, 'globs'],
    ['save_hooks', { name: 'H', argv: ['a'], globs: [1] }, 'globs'],
    ['save_hooks', { name: 'H', argv: ['a'], enabled: 'yes' }, 'enabled'],
    ['save_hooks', { argv: ['a'] }, 'no name'],
  ];
  it.each(cases)('skips a bad %s entry %j and lists why', (key, entry, reason) => {
    const v = parseUserRunView({ commands: [], save_hooks: [], problems: [], path: PATH2, [key]: [ok, entry] });
    const kept = key === 'commands' ? v.commands : v.save_hooks;
    expect(kept.map((e) => e.name)).toEqual(['Ok']);
    expect(v.problems).toHaveLength(1);
    expect(v.problems[0]).toContain(reason);
  });

  it('fills in missing lists and globs, and never throws', () => {
    expect(parseUserRunView(undefined).commands).toEqual([]);
    expect(parseUserRunView(null).problems.length).toBe(1);
    const v = parseUserRunView({ save_hooks: [{ name: 'H', argv: ['a'], globs: null }] });
    expect(v.save_hooks[0]).toMatchObject({ globs: [], enabled: false });
    expect(v.path).toBe('');
    expect(v.file_error).toBeNull();
    expect(parseUserRunView({ commands: 'x' }).problems[0]).toContain('not a list');
  });
});
