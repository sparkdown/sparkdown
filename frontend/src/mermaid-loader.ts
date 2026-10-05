let mermaidModule: any = null;
let loading: Promise<void> | null = null;

function hashSource(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

export class MermaidLoader {
  private svgCache = new Map<number, string>();
  private theme: 'light' | 'dark' =
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';

  async ensureLoaded(): Promise<void> {
    if (mermaidModule) return;
    if (loading) return loading;

    loading = (async () => {
      const mod = await import('mermaid');
      mermaidModule = mod.default;
      mermaidModule.initialize({
        startOnLoad: false,
        theme: this.theme === 'dark' ? 'dark' : 'default',
      });
    })();

    return loading;
  }

  async renderAll(container: HTMLElement): Promise<void> {
    if (!mermaidModule) return;

    const nodes = container.querySelectorAll<HTMLElement>('.mermaid');
    if (nodes.length === 0) return;

    const toRender: HTMLElement[] = [];
    let idx = 0;
    nodes.forEach((node) => {
      if (node.getAttribute('data-processed')) return;
      const source = node.textContent ?? '';
      const key = hashSource(source);
      const cached = this.svgCache.get(key);
      if (cached) {
        node.innerHTML = cached;
        node.setAttribute('data-processed', 'true');
        return;
      }
      node.id = `mermaid-${Date.now()}-${idx++}`;
      // Stash the source so we can hash again after mermaid mutates the node
      node.dataset.mermaidSrc = source;
      toRender.push(node);
    });

    if (toRender.length === 0) return;

    try {
      await mermaidModule.run({ nodes: toRender });
      for (const node of toRender) {
        const source = node.dataset.mermaidSrc ?? '';
        if (source) {
          this.svgCache.set(hashSource(source), node.innerHTML);
          delete node.dataset.mermaidSrc;
        }
      }
    } catch (err) {
      console.warn('Mermaid render error:', err);
    }
  }

  updateTheme(theme: 'light' | 'dark'): void {
    this.theme = theme;
    this.svgCache.clear();
    if (!mermaidModule) return;
    mermaidModule.initialize({
      startOnLoad: false,
      theme: theme === 'dark' ? 'dark' : 'default',
    });
  }
}
