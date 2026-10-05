import { describe, it, expect } from 'vitest';
import { manualChunks } from '../../vite.config';

describe('vite manualChunks', () => {
  it('does not group mermaid or its deps, so per-diagram chunks stay split', () => {
    for (const id of [
      '/p/node_modules/mermaid/dist/mermaid.core.mjs',
      '/p/node_modules/mermaid/dist/chunks/mermaid.core/flowDiagram-X.mjs',
      '/p/node_modules/mermaid/dist/chunks/mermaid.core/sequenceDiagram-X.mjs',
      '/p/node_modules/cytoscape/dist/cytoscape.esm.mjs',
      '/p/node_modules/d3-selection/src/index.js',
      '/p/node_modules/dompurify/dist/purify.es.mjs',
    ]) {
      expect(manualChunks(id), id).toBeUndefined();
    }
  });

  it('keeps the highlight and marked vendor chunks', () => {
    expect(manualChunks('/p/node_modules/highlight.js/lib/core.js')).toBe('highlight');
    expect(manualChunks('/p/node_modules/marked/lib/marked.esm.js')).toBe('marked');
  });
});
