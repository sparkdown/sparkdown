// @vitest-environment jsdom
/**
 * The agent context only carries tabs of the machine the window is connected
 * to: a local buffer is never sent to a remote host (or the other way round).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mcpPublish = vi.fn(async (..._args: unknown[]) => undefined);
const agentContextUpdate = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../api', () => ({
  api: {
    mcpPublish: (...a: unknown[]) => mcpPublish(...a),
    agentContextUpdate: (...a: unknown[]) => agentContextUpdate(...a),
    windowSetDirty: vi.fn(async () => undefined),
  },
}));

import { AgentContextBridge } from '../app/agent-context';
import { TabManager } from '../tabs';
import { EventBus } from '../events';

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

function setup() {
  const tabs = new TabManager(new EventBus());
  const container = document.createElement('div');
  document.body.appendChild(container);
  tabs.init(container);
  const ctx = {
    tabs,
    config: { agent_context_enabled: true },
    fileTree: { getRoot: () => '/proj' },
    baseDir: '/proj',
    editor: {
      getContent: () => 'live',
      getCursorLine: () => 1,
      getSelectionText: () => null,
    },
  };
  const bridge = new AgentContextBridge(ctx as never, { openFile: async () => {} });
  bridge.arm();
  return { tabs, bridge };
}

describe('AgentContextBridge origin filter', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mcpPublish.mockClear();
    agentContextUpdate.mockClear();
  });

  it('leaves tabs of another machine out of the snapshot and the file bridge', async () => {
    const { tabs, bridge } = setup();
    tabs.openTab('/proj/local.md', 'local text');
    tabs.setOrigin('devbox');
    tabs.openTab('/proj/remote.md', 'remote text');
    await bridge.publish();

    const snapshot = mcpPublish.mock.calls[mcpPublish.mock.calls.length - 1]?.[0] as {
      tabs: { path: string | null }[];
      active_path: string | null;
    };
    expect(snapshot.tabs.map((t) => t.path)).toEqual(['/proj/remote.md']);
    expect(snapshot.active_path).toBe('/proj/remote.md');

    const [, json, buffers] = agentContextUpdate.mock.calls[agentContextUpdate.mock.calls.length - 1] as [string, string, unknown[]];
    const written = JSON.parse(json) as { tabs: { path: string | null }[] };
    expect(written.tabs.map((t) => t.path)).toEqual(['/proj/remote.md']);
    expect(JSON.stringify(buffers)).not.toContain('local text');
  });

  it('does not report the active tab of another machine as the active one', async () => {
    const { tabs, bridge } = setup();
    tabs.openTab('/proj/local.md', 'local text');
    tabs.setOrigin('devbox');
    await bridge.publish();
    const snapshot = mcpPublish.mock.calls[mcpPublish.mock.calls.length - 1]?.[0] as {
      tabs: unknown[];
      active_path: string | null;
    };
    expect(snapshot.tabs).toEqual([]);
    expect(snapshot.active_path).toBeNull();
  });
});
