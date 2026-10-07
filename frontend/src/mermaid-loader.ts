let mermaidModule: any = null;
let loading: Promise<void> | null = null;

function hashSource(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

/**
 * Object.groupBy (ES2024) for older WebKit (Safari < 17.4; tauri.conf.json
 * still allows macOS 10.15). mermaid 12 bundles chevrotain, whose grammar
 * validation calls it: the usecase-beta parser runs that validation when it
 * loads, and the langium parsers (pie, gitGraph, ...) carry the same code but
 * skip it in production mode. Installed before mermaid loads, only when the
 * native one is missing. Follows the spec: items must be iterable, the
 * callback gets (value, index), keys go through ToPropertyKey once, and the
 * result is a null-prototype object of arrays.
 */
export function installObjectGroupByPolyfill(): void {
  const O = Object as unknown as { groupBy?: unknown };
  if (typeof O.groupBy === 'function') return;
  Object.defineProperty(Object, 'groupBy', {
    value: function groupBy<T>(
      items: Iterable<T>,
      callbackfn: (value: T, index: number) => PropertyKey,
    ): Record<PropertyKey, T[]> {
      if (items === null || items === undefined) {
        throw new TypeError('Object.groupBy called on null or undefined');
      }
      if (typeof callbackfn !== 'function') {
        throw new TypeError('Object.groupBy: callback is not a function');
      }
      const groups: Record<PropertyKey, T[]> = Object.create(null);
      let k = 0;
      for (const value of items) {
        if (k >= Number.MAX_SAFE_INTEGER) {
          throw new TypeError('Object.groupBy: too many items');
        }
        // A computed property name applies ToPropertyKey exactly once.
        const key = Reflect.ownKeys({ [callbackfn(value, k)]: 0 })[0];
        const group = groups[key];
        if (group) group.push(value);
        else groups[key] = [value];
        k++;
      }
      return groups;
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

/**
 * Options for mermaid.initialize(). initialize() replaces the whole site
 * config, so every call (first load and theme switch) must pass all of them.
 *
 * mermaid 12 changed the defaults: the top-level `layout` went from 'dagre'
 * to 'elk', and flowchart, sequence, class, state and other diagrams now
 * default to `look: 'neo'` (and a 'redux-color' theme). Top-level values
 * passed here override those per-diagram defaults, so this keeps the
 * mermaid 11 rendering and stops flowcharts from loading the ~1.5 MB ELK
 * chunk.
 */
export function mermaidConfig(theme: 'light' | 'dark') {
  return {
    startOnLoad: false,
    theme: theme === 'dark' ? 'dark' : 'default',
    layout: 'dagre',
    look: 'classic',
  } as const;
}

export class MermaidLoader {
  private svgCache = new Map<number, string>();
  private theme: 'light' | 'dark' =
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';

  async ensureLoaded(): Promise<void> {
    if (mermaidModule) return;
    if (loading) return loading;

    loading = (async () => {
      installObjectGroupByPolyfill();
      const mod = await import('mermaid');
      mermaidModule = mod.default;
      mermaidModule.initialize(mermaidConfig(this.theme));
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
    mermaidModule.initialize(mermaidConfig(theme));
  }
}
