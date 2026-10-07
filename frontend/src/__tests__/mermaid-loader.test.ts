import { describe, it, expect } from 'vitest';
import { mermaidConfig } from '../mermaid-loader';

describe('mermaidConfig', () => {
  it('keeps the mermaid 11 layout and look for both themes', () => {
    expect(mermaidConfig('light')).toEqual({
      startOnLoad: false,
      theme: 'default',
      layout: 'dagre',
      look: 'classic',
    });
    expect(mermaidConfig('dark')).toMatchObject({ theme: 'dark', layout: 'dagre', look: 'classic' });
  });
});
