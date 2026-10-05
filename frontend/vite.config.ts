import { defineConfig } from 'vite';

/**
 * Vendor chunk grouping for the production build.
 *
 * Do NOT group mermaid (or its deps: cytoscape, d3, langium, dagre, ...) into
 * one chunk. Mermaid loads each diagram type with its own dynamic import, and
 * a manual group merges all of them into one ~3 MB chunk. The group also
 * absorbs modules that the app shares with mermaid (DOMPurify, bundler
 * helpers), so the entry chunk then imports that chunk statically and the
 * whole of mermaid loads at startup. Without a group, the app loads mermaid
 * core only when a document has a diagram, plus one chunk per diagram type.
 */
export function manualChunks(id: string): string | undefined {
  if (id.includes('node_modules/highlight.js')) return 'highlight';
  if (id.includes('node_modules/marked')) return 'marked';
  return undefined;
}

export default defineConfig({
  build: {
    outDir: 'dist',
    target: 'es2021',
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
});
