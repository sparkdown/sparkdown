// @vitest-environment jsdom
/**
 * Status bar items added by the title bar / status bar revamp: the unsaved
 * dot, the git branch with ahead/behind, the agent tools (MCP) state, and
 * the clickable Ln/Col and Wrap. The counts keep their exact text.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api', () => ({ api: { copyText: vi.fn() } }));
vi.mock('../context-menu', () => ({ showContextMenu: vi.fn() }));

import { StatusBar, formatBranch } from '../statusbar';
import { EventBus } from '../events';
import { ACTIONS, EVENTS } from '../event-names';
import type { GitBranchStatus } from '../api';

const branch = (over: Partial<GitBranchStatus> = {}): GitBranchStatus => ({
  branch: 'main',
  detached: false,
  has_upstream: true,
  ahead: 0,
  behind: 0,
  ...over,
});

describe('formatBranch', () => {
  it('shows only the non-zero ahead / behind counts', () => {
    expect(formatBranch(branch()).text).toBe('main');
    expect(formatBranch(branch({ ahead: 1 })).text).toBe('main ↑1');
    expect(formatBranch(branch({ behind: 3 })).text).toBe('main ↓3');
    expect(formatBranch(branch({ ahead: 2, behind: 5 })).text).toBe('main ↑2 ↓5');
  });

  it('explains the sync state in the tooltip', () => {
    expect(formatBranch(branch({ ahead: 1 })).title).toBe('Branch main, 1 commit ahead');
    expect(formatBranch(branch({ ahead: 2, behind: 1 })).title).toBe(
      'Branch main, 2 commits ahead, 1 commit behind',
    );
    expect(formatBranch(branch()).title).toContain('up to date');
    expect(formatBranch(branch({ has_upstream: false })).title).toBe('Branch main (no upstream)');
  });

  it('shows the short commit id for a detached HEAD', () => {
    const f = formatBranch(branch({ branch: '431cb0f', detached: true, has_upstream: false }));
    expect(f.text).toBe('431cb0f');
    expect(f.title).toContain('Detached HEAD');
  });
});

describe('StatusBar items', () => {
  let bus: EventBus;
  let bar: StatusBar;
  const el = (id: string) => document.getElementById(id)!;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="status-bar">
        <span id="status-path"></span>
        <i id="status-modified" class="status-dirty"></i>
        <span id="status-branch" class="hidden"><span class="status-branch-name"></span></span>
        <button id="status-agent" class="hidden"><i></i><span class="status-agent-label"></span></button>
        <span id="status-words">0 words</span>
        <span id="status-chars">0 chars</span>
        <span id="status-lines">0 lines</span>
        <button id="status-cursor">Ln 1, Col 1</button>
        <button id="status-wrap">Wrap: On</button>
      </div>`;
    bus = new EventBus();
    bar = new StatusBar(bus);
    bar.init();
  });

  it('keeps the counts, Ln/Col and Wrap text exactly', () => {
    bar.updateCounts(1284, 212, 8907);
    bus.emit(EVENTS.CURSOR_CHANGED, { line: 48, column: 12, chars: 8907, selectedChars: 0 });
    bar.updateWrap(true);
    expect(el('status-words').textContent).toBe('1284 words');
    expect(el('status-chars').textContent).toBe('8907 chars');
    expect(el('status-lines').textContent).toBe('212 lines');
    expect(el('status-cursor').textContent).toBe('Ln 48, Col 12');
    expect(el('status-wrap').textContent).toBe('Wrap: On');
  });

  it('shows an unsaved dot instead of "(modified)" text', () => {
    bar.updateModified(true);
    expect(el('status-modified').classList.contains('is-dirty')).toBe(true);
    expect(el('status-modified').title).toBe('Unsaved changes');
    expect(el('status-modified').textContent).toBe('');
    bar.updateModified(false);
    expect(el('status-modified').classList.contains('is-dirty')).toBe(false);
  });

  it('renders the branch with ahead/behind, and hides without one', () => {
    bar.setBranch(branch({ ahead: 1, behind: 2 }));
    expect(el('status-branch').classList.contains('hidden')).toBe(false);
    expect(el('status-branch').querySelector('.status-branch-name')!.textContent).toBe(
      'main ↑1 ↓2',
    );
    bar.setBranch(branch({ branch: null }));
    expect(el('status-branch').classList.contains('hidden')).toBe(true);
    bar.setBranch(branch());
    bar.setBranch(null);
    expect(el('status-branch').classList.contains('hidden')).toBe(true);
  });

  it('shows agent tools on only when the server runs and sharing is allowed', () => {
    const label = () => el('status-agent').querySelector('.status-agent-label')!.textContent;
    bar.setAgentTools({ running: true, enabled: true });
    expect(el('status-agent').classList.contains('hidden')).toBe(false);
    expect(el('status-agent').classList.contains('is-on')).toBe(true);
    expect(label()).toBe('Agent tools on');

    bar.setAgentTools({ running: true, enabled: false });
    expect(label()).toBe('Agent tools off');
    expect(el('status-agent').title).toContain('Settings → Agents');

    bar.setAgentTools({ running: false, enabled: true });
    expect(label()).toBe('Agent tools off');
    expect(el('status-agent').title).toContain('not running');

    bar.setAgentTools(null);
    expect(el('status-agent').classList.contains('hidden')).toBe(true);
  });

  it('Ln/Col goes to line, Wrap toggles wrap, agent tools opens settings', () => {
    const seen: string[] = [];
    bus.on(ACTIONS.GOTO_LINE, () => seen.push('goto'));
    bus.on(ACTIONS.TOGGLE_WRAP, () => seen.push('wrap'));
    bus.on(ACTIONS.SHOW_AGENT_SETTINGS, () => seen.push('agents'));
    el('status-cursor').click();
    el('status-wrap').click();
    el('status-agent').click();
    expect(seen).toEqual(['goto', 'wrap', 'agents']);
    expect(el('status-cursor').title).toMatch(/Go to line/);
  });
});
