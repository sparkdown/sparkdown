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
import { SettingsDialog } from '../settings-dialog';

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

  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    calls = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      calls.push([cmd, args]);
      if (cmd === 'detect_agents') return agents;
      if (cmd === 'mcp_shim_command') return { program: '/opt/sd', args: ['--mcp-stdio'] };
      if (cmd === 'mcp_agent_installed') return false;
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
