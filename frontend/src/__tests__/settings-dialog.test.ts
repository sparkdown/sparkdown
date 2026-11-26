// @vitest-environment jsdom
/** Settings dialog: open / close state lives on the instance (no module
 *  state), so each test simply builds a new SettingsDialog. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === 'detect_agents') return [];
    if (cmd === 'mcp_shim_command') return null;
    throw new Error(`unmocked ${cmd}`);
  }),
}));

import { invoke } from '@tauri-apps/api/core';
import type { AppConfig } from '../api';
import { SettingsDialog, mcpStatusText, MCP_ACTION_BACKSTOP_MS } from '../settings-dialog';

const overlays = () => document.querySelectorAll('.settings-overlay');

describe('SettingsDialog', () => {
  let config: AppConfig;
  let changes: number;
  const host = () => ({ config, onChange: () => { changes++; } });

  beforeEach(() => {
    document.body.innerHTML = '<div id="app"><textarea id="editor"></textarea></div>';
    (document.getElementById('editor') as HTMLTextAreaElement).focus();
    config = { use_tmux: false, agent_context_enabled: false } as AppConfig;
    changes = 0;
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('toggle opens, toggles closed, and restores the app', () => {
    const dialog = new SettingsDialog();
    dialog.toggle(host());
    expect(dialog.isOpen).toBe(true);
    expect(overlays()).toHaveLength(1);
    expect(document.getElementById('app')!.hasAttribute('inert')).toBe(true);

    dialog.toggle(host());
    expect(dialog.isOpen).toBe(false);
    expect(overlays()).toHaveLength(0);
    expect(document.getElementById('app')!.hasAttribute('inert')).toBe(false);
    expect(document.activeElement?.id).toBe('editor');
  });

  it('Escape, × and the backdrop close it and drop the key handler', () => {
    const dialog = new SettingsDialog();
    const closers = [
      () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
      () => document.querySelector<HTMLButtonElement>('.settings-close')!.click(),
      () => document.querySelector<HTMLElement>('.settings-overlay')!.click(),
    ];
    for (const close of closers) {
      dialog.toggle(host());
      close();
      expect(dialog.isOpen).toBe(false);
      expect(overlays()).toHaveLength(0);
    }
    // No stale Escape handler: a later Escape with nothing open is a no-op,
    // and the next toggle opens again (not closes).
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    dialog.toggle(host());
    expect(dialog.isOpen).toBe(true);
    dialog.close();
  });

  it('a toggle writes the live config and calls onChange', () => {
    const dialog = new SettingsDialog();
    dialog.toggle(host());
    const tmux = document.querySelector<HTMLInputElement>('.settings-switch')!;
    tmux.checked = true;
    tmux.dispatchEvent(new Event('change'));
    expect(config.use_tmux).toBe(true);
    expect(changes).toBe(1);
    dialog.close();
  });

  it('scrollback uses bounded numeric input and applies/persists via onChange', () => {
    config.terminal_scrollback = 5000;
    const dialog = new SettingsDialog();
    dialog.toggle(host());
    const settings = [...document.querySelectorAll('.settings-section')].find((el) =>
      el.textContent?.includes('Scrollback lines'),
    )!;
    const input = settings.querySelector<HTMLInputElement>('input[type="number"]')!;
    expect(document.querySelectorAll('[data-setting-scrollback]')).toHaveLength(1);
    expect(input.min).toBe('200');
    expect(input.max).toBe('50000');
    input.value = '200';
    input.dispatchEvent(new Event('change'));
    expect(config.terminal_scrollback).toBe(200);
    expect(changes).toBe(1);
    // Temporary input must not snap to the 200-line minimum while typing.
    input.value = '';
    input.dispatchEvent(new Event('input'));
    expect(changes).toBe(1);
    input.value = '900';
    input.dispatchEvent(new Event('change'));
    expect(config.terminal_scrollback).toBe(900);
    expect(changes).toBe(2);
    expect(document.body.textContent).toContain('applied live');
    dialog.close();
  });

  const scrollbackInput = () =>
    document.querySelector<HTMLInputElement>('[data-setting-scrollback]')!;
  /** Type into the field the way a user does: replace, then input events. */
  const typeInto = (input: HTMLInputElement, text: string) => {
    input.focus();
    input.value = '';
    for (const ch of text) {
      input.value += ch;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };

  it('box QA: typing 350 then Tab saves 350 (no step mismatch drop)', () => {
    config.terminal_scrollback = 5000;
    const dialog = new SettingsDialog();
    dialog.toggle(host());
    const input = scrollbackInput();
    typeInto(input, '350');
    // An in-range whole number must be valid; a step of 100 based at the
    // 200 minimum made 350 a stepMismatch and the save silently returned.
    expect(input.validity.stepMismatch).toBe(false);
    input.dispatchEvent(new Event('change')); // Tab / blur commits
    expect(config.terminal_scrollback).toBe(350);
    expect(changes).toBe(1);
    dialog.close();
    // Reopen: shows the saved value, not the default.
    dialog.toggle(host());
    expect(scrollbackInput().value).toBe('350');
    dialog.close();
  });

  it('Enter commits; closing with Escape commits a typed, uncommitted value', () => {
    config.terminal_scrollback = 5000;
    const dialog = new SettingsDialog();
    dialog.toggle(host());
    let input = scrollbackInput();
    typeInto(input, '1234');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(config.terminal_scrollback).toBe(1234);
    expect(changes).toBe(1);
    typeInto(input, '777');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(dialog.isOpen).toBe(false);
    expect(config.terminal_scrollback).toBe(777);
    expect(changes).toBe(2);
    // Closing again with nothing typed does not re-save.
    dialog.toggle(host());
    input = scrollbackInput();
    dialog.close();
    expect(changes).toBe(2);
  });

  it('out-of-range values clamp (and show the clamp); junk keeps the saved value', () => {
    config.terminal_scrollback = 5000;
    const dialog = new SettingsDialog();
    dialog.toggle(host());
    const input = scrollbackInput();
    typeInto(input, '10');
    input.dispatchEvent(new Event('change'));
    expect(config.terminal_scrollback).toBe(200);
    expect(input.value).toBe('200');
    typeInto(input, '999999');
    input.dispatchEvent(new Event('change'));
    expect(config.terminal_scrollback).toBe(50_000);
    expect(input.value).toBe('50000');
    typeInto(input, '');
    input.dispatchEvent(new Event('change'));
    expect(config.terminal_scrollback).toBe(50_000);
    expect(input.value).toBe('50000');
    expect(changes).toBe(2);
    dialog.close();
  });

  it('Settings → Git → "Fetch in the background" is on by default and writes the config (#175)', () => {
    const dialog = new SettingsDialog();
    dialog.toggle(host());
    const section = document.querySelector<HTMLElement>('[data-section="git"]')!;
    expect(section.querySelector('h3')!.textContent).toBe('Git');
    const row = [...section.querySelectorAll('.settings-row')].find((r) =>
      r.textContent!.includes('Fetch in the background'),
    )!;
    const sw = row.querySelector<HTMLInputElement>('.settings-switch')!;
    expect(sw.checked).toBe(true); // missing in the config = default on
    sw.checked = false;
    sw.dispatchEvent(new Event('change'));
    expect(config.git_background_fetch).toBe(false);
    expect(changes).toBe(1);
    dialog.close();
  });

  it('instances are independent', () => {
    const a = new SettingsDialog();
    const b = new SettingsDialog();
    a.toggle(host());
    expect(b.isOpen).toBe(false);
    b.close(); // closing the other one does not touch a
    expect(a.isOpen).toBe(true);
    a.close();
    expect(overlays()).toHaveLength(0);
  });

  it('labels the updates toggle Check for updates and writes the preference', async () => {
    const dialog = new SettingsDialog();
    dialog.toggle(host());
    const section = [...document.querySelectorAll('.settings-section')].find((el) =>
      el.querySelector('h3')?.textContent === 'Updates',
    )!;
    expect(section.textContent).toContain('Check for updates');
    expect(section.textContent).not.toContain('Check for updates automatically');
    const toggle = section.querySelector<HTMLInputElement>('.settings-switch')!;
    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    expect(config.check_updates_automatically).toBe(false);
    expect(changes).toBe(1);
    dialog.close();
  });
});

describe('SettingsDialog → Agents MCP rows', () => {
  const flush = async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const agents = [
    { id: 'gemini', label: 'Gemini', bin: 'gemini', found: true },
    { id: 'cursor', label: 'Cursor CLI', bin: 'cursor-agent', found: true },
    { id: 'antigravity', label: 'Antigravity', bin: 'agy', found: true },
    { id: 'opencode', label: 'opencode', bin: 'opencode', found: true },
  ];
  let calls: Array<[string, unknown]>;
  let statuses: Record<string, { installed: boolean; command: string | null; stale: string | null }>;

  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    calls = [];
    statuses = {};
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      calls.push([cmd, args]);
      if (cmd === 'detect_agents') return agents;
      if (cmd === 'mcp_shim_command') return { program: '/opt/sd', args: ['--mcp-stdio'] };
      if (cmd === 'mcp_agent_status') {
        const bin = (args as { bin: string }).bin;
        return statuses[bin] ?? { installed: false, command: null, stale: null };
      }
      if (cmd === 'mcp_install_agent') return 'Installed';
      throw new Error(`unmocked ${cmd}`);
    });
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const rowLabels = () =>
    [...document.querySelectorAll('.settings-mcp-list .settings-row-label')].map(
      (e) => e.textContent,
    );

  it('lists Cursor as installable (not opencode: it is per-session), and Install runs the backend install', async () => {
    const config = { mcp_install_prompt_dismissed: [] } as unknown as AppConfig;
    const dialog = new SettingsDialog();
    dialog.toggle({ config, onChange: () => {} });
    await flush();
    expect(rowLabels()).toEqual(['Gemini', 'Cursor CLI', 'Antigravity']);
    const cursorRow = [...document.querySelectorAll('.settings-mcp-list .settings-row')].find(
      (r) => r.textContent?.includes('Cursor CLI'),
    )!;
    cursorRow.querySelector<HTMLButtonElement>('.settings-btn')!.click();
    await flush();
    expect(calls).toContainEqual(['mcp_install_agent', { bin: 'cursor-agent' }]);
    expect(cursorRow.textContent).toContain('Installed');
    dialog.close();
  });

  it('a stale entry (deleted binary) is not shown as Installed and Repair reinstalls it (#32)', async () => {
    statuses['gemini'] = {
      installed: true,
      command: '/home/u/.local/bin/sparkdown',
      stale: 'missing',
    };
    statuses['agy'] = { installed: true, command: '/opt/sd', stale: null };
    const config = {} as AppConfig;
    const dialog = new SettingsDialog();
    dialog.toggle({ config, onChange: () => {} });
    await flush();
    const rows = [...document.querySelectorAll<HTMLElement>('.settings-mcp-list .settings-row')];
    const gemini = rows.find((r) => r.textContent?.includes('Gemini'))!;
    const agy = rows.find((r) => r.textContent?.includes('Antigravity'))!;
    const desc = gemini.querySelector('.settings-row-desc')!;
    expect(desc.textContent).toContain('Broken');
    expect(desc.textContent).toContain('/home/u/.local/bin/sparkdown');
    expect(desc.textContent).not.toBe('Installed');
    const repair = gemini.querySelector<HTMLButtonElement>('.settings-mcp-repair')!;
    expect(repair.hidden).toBe(false);
    // A healthy entry has no Repair.
    expect(agy.querySelector('.settings-row-desc')!.textContent).toBe('Installed');
    expect(agy.querySelector<HTMLButtonElement>('.settings-mcp-repair')!.hidden).toBe(true);

    repair.click();
    await flush();
    expect(calls).toContainEqual(['mcp_install_agent', { bin: 'gemini' }]);
    expect(desc.textContent).toBe('Installed');
    expect(repair.hidden).toBe(true);
    dialog.close();
  });

  it('mcpStatusText words each state', () => {
    expect(mcpStatusText({ installed: false, command: null, stale: null })).toBe('Not installed');
    expect(mcpStatusText({ installed: true, command: '/x', stale: null })).toBe('Installed');
    expect(mcpStatusText({ installed: true, command: '/x', stale: 'other' })).toContain('another SparkDown (/x)');
  });

  it('"Ask again when launching" clears the dismissed prompts', async () => {
    const config = {
      mcp_install_prompt_dismissed: ['gemini', 'cursor-agent'],
    } as unknown as AppConfig;
    let changed = 0;
    const dialog = new SettingsDialog();
    dialog.toggle({ config, onChange: () => changed++ });
    await flush();
    const row = document.querySelector<HTMLElement>('.settings-mcp-ask-again')!;
    expect(row.textContent).toContain('Gemini, Cursor CLI');
    row.querySelector<HTMLButtonElement>('button')!.click();
    expect(config.mcp_install_prompt_dismissed).toEqual([]);
    expect(changed).toBe(1);
    expect(document.querySelector('.settings-mcp-ask-again')).toBeNull();
    dialog.close();
  });

  it('no reset row when nothing was dismissed', async () => {
    const config = {} as AppConfig;
    const dialog = new SettingsDialog();
    dialog.toggle({ config, onChange: () => {} });
    await flush();
    expect(document.querySelector('.settings-mcp-ask-again')).toBeNull();
    dialog.close();
  });
});

describe('agent MCP row actions (#49)', () => {
  const mocked = invoke as unknown as ReturnType<typeof vi.fn>;
  let addResult: () => Promise<unknown>;

  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    addResult = () => Promise.resolve('ok');
    mocked.mockImplementation(async (cmd: string) => {
      if (cmd === 'detect_agents') return [{ id: 'claude', label: 'Claude Code', bin: 'claude', found: true }];
      if (cmd === 'mcp_shim_command') return { program: '/usr/bin/sparkdown', args: [] };
      if (cmd === 'mcp_agent_status')
        return { installed: true, command: '/gone/sparkdown', stale: 'missing' };
      if (cmd === 'mcp_install_agent') return addResult();
      throw new Error(`unmocked ${cmd}`);
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const open = async () => {
    const dialog = new SettingsDialog();
    dialog.toggle({ config: { mcp_install_prompt_dismissed: [] } as unknown as AppConfig, onChange: () => {} });
    await settle();
    await new Promise((r) => setTimeout(r, 0));
    await settle();
    const repair = document.querySelector<HTMLButtonElement>('.settings-mcp-repair')!;
    const desc = repair.parentElement!.querySelector<HTMLElement>('.settings-row-desc')!;
    return { dialog, repair, desc };
  };

  it('a failed Repair shows the CLI error and the button reads Repair again', async () => {
    addResult = () => Promise.reject('`claude mcp add` failed (exit code 1):\nError: not logged in');
    const { dialog, repair, desc } = await open();
    expect(repair.hidden).toBe(false);
    repair.click();
    expect(repair.textContent).toBe('Repairing…');
    await settle();
    expect(repair.textContent).toBe('Repair');
    expect(repair.disabled).toBe(false);
    expect(desc.textContent).toContain('exit code 1');
    expect(desc.textContent).toContain('Error: not logged in');
    expect(desc.classList.contains('settings-row-error')).toBe(true);
    dialog.close();
  });

  it('a Repair that never answers is ended by the backstop', async () => {
    const { dialog, repair, desc } = await open();
    vi.useFakeTimers();
    addResult = () => new Promise(() => {});
    repair.click();
    expect(repair.textContent).toBe('Repairing…');
    await vi.advanceTimersByTimeAsync(MCP_ACTION_BACKSTOP_MS + 10);
    expect(repair.textContent).toBe('Repair');
    expect(repair.disabled).toBe(false);
    expect(desc.textContent).toContain('did not answer');
    dialog.close();
  });

});

describe('Custom commands in Settings', () => {
  let config: AppConfig;
  let commands: { name: string; argv: string[] }[];
  let saved: { name: string; argv: string[] }[] | null;
  let opened: number;

  let hooks: { name: string; argv: string[]; globs: string[]; enabled: boolean }[];

  const userRun = () => ({
    view: () => ({
      commands,
      save_hooks: hooks,
      problems: commands.length ? [] : ['Command 2 has no name; it was ignored.'],
      path: '/cfg/user-run.json',
    }),
    saveCommands: async (next: { name: string; argv: string[] }[]) => {
      saved = next;
      commands = next.map((c) => ({ ...c, argv: [...c.argv] }));
    },
    saveHooks: async (next: { name: string; argv: string[]; globs: string[]; enabled: boolean }[]) => {
      hooks = next.map((h) => ({ ...h, argv: [...h.argv], globs: [...h.globs] }));
    },
    openFile: () => { opened++; },
  });

  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    config = { use_tmux: false, agent_context_enabled: false } as AppConfig;
    commands = [{ name: 'Format', argv: ['prettier', '--write', '.'] }];
    hooks = [];
    saved = null;
    opened = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('lists commands and saves an edit', async () => {
    const dialog = new SettingsDialog();
    dialog.toggle({ config, onChange: () => {}, userRun: userRun() });
    const section = document.querySelector('[data-section="commands"]')!;
    expect(section.textContent).toContain('Custom commands');
    expect(section.querySelector<HTMLInputElement>('input[data-run-field="name"]')!.value).toBe('Format');
    const run = section.querySelector<HTMLInputElement>('input[data-run-field="run"]')!;
    expect(run.value).toBe('prettier --write .');
    run.value = 'prettier --write src';
    run.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(500);
    expect(saved?.[0]?.argv).toEqual(['prettier', '--write', 'src']);
    dialog.close();
  });

  it('adds and removes a command, and opens the file', async () => {
    const dialog = new SettingsDialog();
    dialog.toggle({ config, onChange: () => {}, userRun: userRun() });
    const section = document.querySelector('[data-section="commands"]')!;
    const add = [...section.querySelectorAll('button')].find((b) => b.textContent === 'Add command')!;
    add.click();
    await vi.advanceTimersByTimeAsync(500);
    expect(saved?.some((c) => c.name === 'New command')).toBe(true);
    expect(section.querySelectorAll('.settings-run-item')).toHaveLength(2);
    const remove = [...section.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!;
    remove.click();
    await vi.advanceTimersByTimeAsync(500);
    expect(section.querySelectorAll('.settings-run-item')).toHaveLength(1);
    const open = [...section.querySelectorAll('button')].find((b) => b.textContent === 'Open user-run.json')!;
    open.click();
    expect(opened).toBe(1);
    dialog.close();
  });

  it('shows skipped-entry notes and does not appear without userRun', () => {
    commands = [];
    const dialog = new SettingsDialog();
    dialog.toggle({ config, onChange: () => {}, userRun: userRun() });
    const problems = document.querySelector('.settings-run-problems') as HTMLElement;
    expect(problems.hidden).toBe(false);
    expect(problems.textContent).toContain('no name');
    dialog.close();

    dialog.toggle({ config, onChange: () => {} });
    expect(document.querySelector('[data-section="commands"]')).toBeNull();
    dialog.close();
  });
});

describe('On-save hooks in Settings', () => {
  let config: AppConfig;
  const hooks = [
    { name: 'Format', argv: ['prettier', '--write'], globs: ['*.md'], enabled: false },
  ];
  let savedHooks: typeof hooks | null;

  const userRun = () => ({
    view: () => ({ commands: [], save_hooks: hooks, problems: [], path: '/cfg/user-run.json' }),
    saveCommands: async () => {},
    saveHooks: async (next: typeof hooks) => { savedHooks = next; },
    openFile: () => {},
  });

  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    config = { use_tmux: false, agent_context_enabled: false } as AppConfig;
    hooks[0] = { name: 'Format', argv: ['prettier', '--write'], globs: ['*.md'], enabled: false };
    savedHooks = null;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('turns a hook on and edits its file filter', async () => {
    const dialog = new SettingsDialog();
    dialog.toggle({ config, onChange: () => {}, userRun: userRun() });
    const section = document.querySelector('[data-section="hooks"]')!;
    expect(section.textContent).toContain('On save');
    const enabled = section.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(enabled.checked).toBe(false);
    enabled.checked = true;
    enabled.dispatchEvent(new Event('change'));
    const files = section.querySelector<HTMLInputElement>('input[data-run-field="hook-globs"]')!;
    expect(files.value).toBe('*.md');
    files.value = '*.md, **/*.ts';
    files.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(500);
    expect(savedHooks?.[0]?.enabled).toBe(true);
    expect(savedHooks?.[0]?.globs).toEqual(['*.md', '**/*.ts']);
    dialog.close();
  });
});

describe('user-run.json problems never keep Settings from opening', () => {
  const config = { use_tmux: false, agent_context_enabled: false } as AppConfig;
  afterEach(() => { document.body.innerHTML = ''; });
  const base = {
    saveCommands: async () => {},
    saveHooks: async () => {},
    openFile: vi.fn(),
  };

  it('stands in a notice with Open user-run.json when the sections cannot be built', () => {
    const dialog = new SettingsDialog();
    const openFile = vi.fn();
    dialog.toggle({
      config,
      onChange: () => {},
      userRun: { ...base, openFile, view: () => { throw new Error('bad view'); } },
    });
    expect(dialog.isOpen).toBe(true);
    expect(document.querySelector('[data-section="terminal"], .settings-dialog h3')?.textContent).toBeTruthy();
    const notice = document.querySelector<HTMLElement>('[data-run-notice]')!;
    expect(notice.textContent).toContain('bad view');
    [...notice.querySelectorAll('button')].find((b) => b.textContent === 'Open user-run.json')!.click();
    expect(openFile).toHaveBeenCalled();
    // Agents section still rendered after the user-run area.
    expect(document.querySelector('[data-section="agents"]')).toBeTruthy();
    dialog.close();
  });

  it('hides the notice for a missing or empty file', () => {
    const dialog = new SettingsDialog();
    dialog.toggle({
      config,
      onChange: () => {},
      userRun: { ...base, view: () => ({ commands: [], save_hooks: [], problems: [], path: '/cfg/user-run.json' }) },
    });
    expect(document.querySelector<HTMLElement>('[data-run-notice]')!.hidden).toBe(true);
    expect(document.querySelector('[data-section="hooks"]')).toBeTruthy();
    dialog.close();
  });
});

describe('Escape closes Settings', () => {
  afterEach(() => { document.body.innerHTML = ''; });
  const config = () => ({ use_tmux: false, agent_context_enabled: false }) as AppConfig;
  const esc = (target: EventTarget) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  const userRun = () => ({
    view: () => ({
      commands: [],
      save_hooks: [{ name: 'New hook', argv: ['echo'], globs: [], enabled: false }],
      problems: [],
      path: '/cfg/user-run.json',
    }),
    saveCommands: async () => {},
    saveHooks: async () => {},
    openFile: () => {},
  });

  it('with focus on a hook Enabled switch, even if a handler there stops the key', () => {
    const dialog = new SettingsDialog();
    dialog.toggle({ config: config(), onChange: () => {}, userRun: userRun() });
    const toggle = document.querySelector<HTMLInputElement>('[data-section="hooks"] input[type="checkbox"]')!;
    toggle.focus();
    toggle.addEventListener('keydown', (e) => e.stopPropagation());
    esc(toggle);
    expect(dialog.isOpen).toBe(false);
    expect(document.querySelector('.settings-overlay')).toBeNull();
  });

  it('when the user-run area fell back to a notice', () => {
    const dialog = new SettingsDialog();
    dialog.toggle({
      config: config(),
      onChange: () => {},
      userRun: { ...userRun(), view: () => { throw new Error('bad view'); } },
    });
    expect(document.querySelector('[data-run-notice]')).toBeTruthy();
    esc(document.querySelector<HTMLButtonElement>('[data-run-notice] button')!);
    expect(dialog.isOpen).toBe(false);
  });

  it('when the dialog could not be built at all', () => {
    const dialog = new SettingsDialog();
    const broken = { onChange: () => {}, get config(): AppConfig { throw new Error('no config'); } };
    dialog.toggle(broken);
    expect(dialog.isOpen).toBe(true);
    expect(document.querySelector('.settings-dialog')!.textContent).toContain('no config');
    esc(document.activeElement ?? document.body);
    expect(dialog.isOpen).toBe(false);
    expect(document.querySelector('.settings-overlay')).toBeNull();
  });
});
