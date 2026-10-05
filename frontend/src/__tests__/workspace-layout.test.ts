// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  applyWorkspaceLayout,
  workspaceLayoutFromConfig,
} from '../workspace-layout';

describe('workspaceLayoutFromConfig', () => {
  it('maps terminals_only true to terminals', () => {
    expect(workspaceLayoutFromConfig(true)).toBe('terminals');
  });

  it('maps false/undefined/null to editor', () => {
    expect(workspaceLayoutFromConfig(false)).toBe('editor');
    expect(workspaceLayoutFromConfig(undefined)).toBe('editor');
    expect(workspaceLayoutFromConfig(null)).toBe('editor');
  });
});

describe('applyWorkspaceLayout', () => {
  it('toggles the terminals-only class on #center-column', () => {
    document.body.innerHTML = `<div id="center-column"><div id="workspace"></div></div>`;
    const center = document.getElementById('center-column')!;

    applyWorkspaceLayout(document, 'terminals');
    expect(center.classList.contains('terminals-only')).toBe(true);

    applyWorkspaceLayout(document, 'editor');
    expect(center.classList.contains('terminals-only')).toBe(false);
  });
});
