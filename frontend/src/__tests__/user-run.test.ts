// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandRegistry } from '../commands';
import { UserRunController } from '../user-run';
import { UserRunOutputLog } from '../user-run-output';
import { HookNotice } from '../hook-notice';
import type { AppConfig, RunOutcome, SaveHook, UserCommand, UserRunView } from '../api';
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
  let focus = false;
  const noticeEl = document.createElement('button');
  noticeEl.className = 'hidden';
  const notice = new HookNotice(noticeEl, showOutput);
  const ctrl = new UserRunController({
    registry,
    root: () => root,
    origin: () => origin,
    openFile,
    showOutput,
    inFocusMode: () => focus,
    notice,
    output,
  });
  return {
    ctrl,
    registry,
    output,
    outputEl,
    openFile,
    showOutput,
    notice,
    noticeEl,
    setFocus: (on: boolean) => { focus = on; },
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

  describe('a failed on-save hook in focus mode', () => {
    const fail = (name: string): RunOutcome => ({
      name, argv: ['false'], cwd: '/ws', exit_code: 1, timed_out: false, output: `${name} said no`,
    });
    const pass = (name: string): RunOutcome => ({
      name, argv: ['true'], cwd: '/ws', exit_code: 0, timed_out: false, output: '',
    });
    const settle = async () => {
      for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    };
    const hooks = [
      { name: 'Lint', argv: ['false'], globs: ['*.md'], enabled: true },
      { name: 'Fmt', argv: ['true'], globs: ['*.md'], enabled: true },
    ];

    it('does not open Output (which would end focus mode); it names the hook instead', async () => {
      loadUserRun.mockResolvedValue(view({ save_hooks: hooks }));
      runSaveHooks.mockResolvedValue([fail('Lint'), pass('Fmt')]);
      const { ctrl, showOutput, noticeEl, setFocus, outputEl } = setup();
      await ctrl.load();
      setFocus(true);
      ctrl.afterSave('/ws/a.md');
      await settle();
      expect(showOutput).not.toHaveBeenCalled();
      expect(noticeEl.classList.contains('hidden')).toBe(false);
      expect(noticeEl.textContent).toBe('On save: Lint failed');
      // The run is still in the Output log for later.
      expect(outputEl.textContent).toContain('Lint said no');

      // Leaving focus mode does not clear it; a click opens Output and does.
      setFocus(false);
      expect(noticeEl.classList.contains('hidden')).toBe(false);
      noticeEl.click();
      expect(showOutput).toHaveBeenCalledTimes(1);
      expect(noticeEl.classList.contains('hidden')).toBe(true);
    });

    it('counts several failures, and a later clean run clears the notice', async () => {
      loadUserRun.mockResolvedValue(view({ save_hooks: hooks }));
      runSaveHooks.mockResolvedValue([fail('Lint'), fail('Fmt')]);
      const { ctrl, noticeEl, setFocus } = setup();
      await ctrl.load();
      setFocus(true);
      ctrl.afterSave('/ws/a.md');
      await settle();
      expect(noticeEl.textContent).toBe('2 on-save hooks failed');
      runSaveHooks.mockResolvedValue([pass('Lint'), pass('Fmt')]);
      ctrl.afterSave('/ws/a.md');
      await settle();
      expect(noticeEl.classList.contains('hidden')).toBe(true);
    });

    it('outside focus mode a failure opens Output as before, with no notice', async () => {
      loadUserRun.mockResolvedValue(view({ save_hooks: hooks }));
      runSaveHooks.mockResolvedValue([fail('Lint')]);
      const { ctrl, showOutput, noticeEl } = setup();
      await ctrl.load();
      ctrl.afterSave('/ws/a.md');
      await settle();
      expect(showOutput).toHaveBeenCalledTimes(1);
      expect(noticeEl.classList.contains('hidden')).toBe(true);
    });

    it('a command the user runs still shows Output in focus mode, and clears the notice', async () => {
      loadUserRun.mockResolvedValue(view({ save_hooks: hooks, commands: [{ name: 'Build', argv: ['make'] }] }));
      runSaveHooks.mockResolvedValue([fail('Lint')]);
      runUserCommand.mockResolvedValue(pass('Build'));
      const { ctrl, registry, showOutput, noticeEl, setFocus } = setup();
      await ctrl.load();
      setFocus(true);
      ctrl.afterSave('/ws/a.md');
      await settle();
      expect(noticeEl.classList.contains('hidden')).toBe(false);
      await registry.get('user.run.build')!.run();
      expect(showOutput).toHaveBeenCalledTimes(1);
      expect(noticeEl.classList.contains('hidden')).toBe(true);
    });
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

  async function openSettings(ctrl: UserRunController) {
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
    await new Promise((r) => setTimeout(r, 0));
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
    const dialog = await openSettings(ctrl);
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
    const dialog = await openSettings(ctrl);
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
    const dialog = await openSettings(ctrl);
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

describe('Settings saves every change, and Esc never discards one', () => {
  type Disk = { commands: UserCommand[]; save_hooks: SaveHook[] };
  let disk: Disk;
  // Behaves like save_user_run: a later entry with a name already used is
  // not written, and comes back as a "Not saved" line.
  const backendSave = async ({ file }: { file: Disk }) => {
    const problems: string[] = [];
    const dedupe = <T extends { name: string }>(list: T[], kind: string) => {
      const seen = new Set<string>();
      return list.filter((e) => {
        if (seen.has(e.name)) {
          problems.push(`Not saved: ${kind} "${e.name}" is duplicated; the later entry was skipped.`);
          return false;
        }
        seen.add(e.name);
        return true;
      });
    };
    disk = {
      commands: dedupe(file.commands, 'Command').map((c) => ({ ...c })),
      save_hooks: dedupe(file.save_hooks, 'On-save hook').map((h) => ({ ...h, globs: [...h.globs] })),
    };
    return { ...disk, problems, path: PATH };
  };

  beforeEach(() => {
    disk = {
      commands: [{ name: 'Hello', argv: ['echo', 'hi'] }],
      save_hooks: [
        { name: 'Mark', argv: ['/bin/false'], globs: ['*.md'], enabled: true },
        { name: 'New hook', argv: ['echo'], globs: [], enabled: false },
      ],
    };
    loadUserRun.mockReset();
    saveUserRun.mockReset();
    loadUserRun.mockImplementation(async () => ({ ...structuredClone(disk), problems: [], path: PATH }));
    saveUserRun.mockImplementation((file: Disk) => backendSave({ file }));
  });
  afterEach(() => { document.body.innerHTML = ''; });

  const tick = () => new Promise((r) => setTimeout(r, 0));
  const config = { use_tmux: false, agent_context_enabled: false } as AppConfig;
  async function open(ctrl: UserRunController) {
    const dialog = new SettingsDialog();
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
    await tick();
    return dialog;
  }
  const esc = (target: EventTarget) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  const button = (section: string, text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(`[data-section="${section}"] button`)].find((b) => b.textContent === text)!;
  const lastHook = () => { const rows = document.querySelectorAll<HTMLElement>('[data-section="hooks"] .settings-run-item'); return rows[rows.length - 1]!; };
  const hookNames = () =>
    [...document.querySelectorAll<HTMLInputElement>('[data-section="hooks"] input[data-run-field="hook-name"]')].map((i) => i.value);

  it('keeps a new hook added next to an existing "New hook" when Esc closes right away', async () => {
    const { ctrl } = setup();
    await ctrl.load();
    let dialog = await open(ctrl);
    button('hooks', 'Add hook').click();
    const toggle = lastHook().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    toggle.focus();
    esc(toggle);
    expect(dialog.isOpen).toBe(false);
    await tick();
    expect(disk.save_hooks.map((h) => [h.name, h.enabled, h.globs])).toEqual([
      ['Mark', true, ['*.md']],
      ['New hook', false, []],
      ['New hook 2', true, []],
    ]);
    dialog = await open(ctrl);
    expect(hookNames()).toEqual(['Mark', 'New hook', 'New hook 2']);
    dialog.close();
  });

  it('saves Add command, and a command and a hook added together, on close', async () => {
    const { ctrl } = setup();
    await ctrl.load();
    const dialog = await open(ctrl);
    button('commands', 'Add command').click();
    button('hooks', 'Add hook').click();
    esc(document.activeElement ?? document.body);
    expect(dialog.isOpen).toBe(false);
    await tick();
    await tick();
    expect(disk.commands.map((c) => c.name)).toEqual(['Hello', 'New command']);
    expect(disk.save_hooks.map((h) => h.name)).toEqual(['Mark', 'New hook', 'New hook 2']);
  });

  it('keeps a hook renamed to a name in use as a marked draft until it is renamed', async () => {
    const { ctrl } = setup();
    await ctrl.load();
    let dialog = await open(ctrl);
    button('hooks', 'Add hook').click();
    const name = lastHook().querySelector<HTMLInputElement>('input[data-run-field="hook-name"]')!;
    name.value = 'Mark';
    name.dispatchEvent(new Event('input'));
    expect(lastHook().dataset.draft).toBe('');
    expect(lastHook().textContent).toContain('Draft, not saved yet');
    esc(name);
    await tick();
    expect(disk.save_hooks.map((h) => h.name)).toEqual(['Mark', 'New hook']);
    dialog = await open(ctrl);
    expect(hookNames()).toEqual(['Mark', 'New hook', 'Mark']);
    expect(lastHook().textContent).toContain('Draft, not saved yet');
    const again = lastHook().querySelector<HTMLInputElement>('input[data-run-field="hook-name"]')!;
    again.value = 'Lint';
    again.dispatchEvent(new Event('input'));
    expect(lastHook().dataset.draft).toBeUndefined();
    dialog.close();
    await tick();
    expect(disk.save_hooks.map((h) => h.name)).toEqual(['Mark', 'New hook', 'Lint']);
    dialog = await open(ctrl);
    expect(document.querySelector('.settings-run-draft')).toBeNull();
    dialog.close();
  });

  it('shows the file as it is now the moment Settings appears', async () => {
    const { ctrl } = setup();
    await ctrl.load();
    loadUserRun.mockImplementation(async () => ({
      ...structuredClone(disk),
      problems: ['Command 2 has no name; it was skipped.'],
      path: PATH,
    }));
    const dialog = new SettingsDialog();
    dialog.toggle({
      config,
      onChange: () => {},
      userRun: {
        view: () => ctrl.view,
        saveCommands: async () => {},
        saveHooks: async () => {},
        openFile: () => {},
        reload: async () => { await ctrl.load(); },
      },
    });
    // Not shown with the old contents first: it appears once the file is read.
    expect(document.querySelector('.settings-overlay')).toBeNull();
    await tick();
    const notice = document.querySelector<HTMLElement>('[data-run-notice]')!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain('Command 2 has no name');
    dialog.close();
  });

  const focusCases: [string, (s: ReturnType<typeof setupFocus>) => HTMLElement][] = [
    ['the dialog', (f) => f.dialog],
    ['a hook Enabled switch', (f) => f.toggleEl],
    ['a hook Name field while typing', (f) => f.type(f.hookName, 'Renamed')],
    ['a command Run field while typing', (f) => f.type(f.run, 'echo changed')],
    ['a hook Timeout field while typing', (f) => f.type(f.timeout, '2500')],
  ];
  function setupFocus() {
    const dialog = document.querySelector<HTMLElement>('.settings-dialog')!;
    const hook = lastHook();
    const type = (el: HTMLInputElement, v: string) => {
      el.value = v;
      el.dispatchEvent(new Event('input'));
      return el;
    };
    return {
      dialog,
      toggleEl: (() => {
        const t = hook.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        t.checked = !t.checked;
        t.dispatchEvent(new Event('change'));
        return t;
      })(),
      hookName: hook.querySelector<HTMLInputElement>('input[data-run-field="hook-name"]')!,
      run: document.querySelector<HTMLInputElement>('[data-section="commands"] input[data-run-field="run"]')!,
      timeout: hook.querySelector<HTMLInputElement>('input[data-run-field="hook-timeout"]')!,
      type,
    };
  }
  it.each(focusCases)('Esc with focus on %s closes and keeps the change', async (_label, pick) => {
    const { ctrl } = setup();
    await ctrl.load();
    const dialog = await open(ctrl);
    const target = pick(setupFocus());
    target.focus();
    esc(target);
    expect(dialog.isOpen).toBe(false);
    expect(document.querySelector('.settings-overlay')).toBeNull();
    await tick();
    await tick();
    // The switch was flipped in every case.
    expect(disk.save_hooks[1]!.enabled).toBe(true);
    if (_label.includes('Name')) expect(disk.save_hooks[1]!.name).toBe('Renamed');
    if (_label.includes('Run')) expect(disk.commands[0]!.argv).toEqual(['echo', 'changed']);
    if (_label.includes('Timeout')) expect(disk.save_hooks[1]!.timeout_ms).toBe(2500);
  });
});

