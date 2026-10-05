// @vitest-environment jsdom
/**
 * Per-file JS trust for the HTML preview is keyed by origin + path: trusting
 * /tmp/deck.html on an SSH host must not trust a local /tmp/deck.html.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const ask = vi.fn(async (..._args: unknown[]) => true);
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: (...a: unknown[]) => ask(...a) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));

import { HtmlScriptsController } from '../app/html-scripts';
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
  const scripts = new HtmlScriptsController(tabs, () => null);
  return { tabs, scripts };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('HtmlScriptsController trust per origin', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    ask.mockClear();
  });

  it('trust granted on a host does not apply to the same local path', async () => {
    const { tabs, scripts } = setup();
    tabs.setOrigin('dev');
    tabs.openTab('/tmp/deck.html', '<p>remote</p>');
    scripts.toggle(true);
    await settle();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(scripts.allowedForActive()).toBe(true);

    // Same path, other machine (a kept tab, or after a disconnect).
    tabs.setOrigin(null);
    tabs.openTab('/tmp/deck.html', '<p>local</p>');
    expect(tabs.activeTab()?.origin).toBeNull();
    expect(scripts.allowedForActive()).toBe(false);
  });

  it('reset() forgets every trust decision', async () => {
    const { tabs, scripts } = setup();
    tabs.openTab('/tmp/deck.html', '<p>x</p>');
    scripts.toggle(true);
    await settle();
    expect(scripts.allowedForActive()).toBe(true);
    scripts.reset();
    expect(scripts.allowedForActive()).toBe(false);
  });
});
