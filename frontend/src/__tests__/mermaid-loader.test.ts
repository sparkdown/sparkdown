// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installObjectGroupByPolyfill, mermaidConfig } from '../mermaid-loader';

// Mock DOMPurify before importing preview
vi.mock('dompurify', () => ({
  default: {
    addHook: vi.fn(),
    removeHook: vi.fn(),
    sanitize: vi.fn((html: string) => html),
  },
}));

// Import after the mocks are registered
import { PreviewPane } from '../preview';
import { EventBus } from '../events';

function makeLivePane() {
  const pane = new PreviewPane(new EventBus());
  const container = document.createElement('div');
  pane.init(container);
  pane.setRenderMode('test.md');
  pane.setPathResolver(() => '/tmp/test.md');
  pane.setOriginResolver(() => null);
  return { pane, container };
}

type GroupBy = <T>(
  items: Iterable<T>,
  callbackfn: (value: T, index: number) => PropertyKey,
) => Record<PropertyKey, T[]>;

const O = Object as unknown as { groupBy?: GroupBy };

describe('mermaidConfig', () => {
  it('keeps the mermaid 11 layout and look for both themes', () => {
    expect(mermaidConfig('light')).toEqual({
      startOnLoad: false,
      theme: 'default',
      layout: 'dagre',
      look: 'classic',
      securityLevel: 'strict',
    });
    expect(mermaidConfig('dark')).toMatchObject({ theme: 'dark', layout: 'dagre', look: 'classic', securityLevel: 'strict' });
  });
});

describe('Object.groupBy polyfill', () => {
  const nativeDescriptor = Object.getOwnPropertyDescriptor(Object, 'groupBy');

  beforeEach(() => {
    delete O.groupBy;
    expect(O.groupBy).toBeUndefined();
    installObjectGroupByPolyfill();
  });

  afterEach(() => {
    delete O.groupBy;
    if (nativeDescriptor) Object.defineProperty(Object, 'groupBy', nativeDescriptor);
  });

  it('installs a non-enumerable, writable, configurable function', () => {
    const d = Object.getOwnPropertyDescriptor(Object, 'groupBy');
    expect(typeof d?.value).toBe('function');
    expect(d).toMatchObject({ writable: true, enumerable: false, configurable: true });
    expect(d?.value.name).toBe('groupBy');
    expect(d?.value.length).toBe(2);
    expect(Object.keys(Object)).not.toContain('groupBy');
  });

  it('groups values in order and passes (value, index)', () => {
    const seen: Array<[number, number]> = [];
    const result = O.groupBy!([1, 2, 3, 4, 5], (n, i) => {
      seen.push([n, i]);
      return n % 2 ? 'odd' : 'even';
    });
    expect(seen).toEqual([[1, 0], [2, 1], [3, 2], [4, 3], [5, 4]]);
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.keys(result)).toEqual(['odd', 'even']);
    expect(result.odd).toEqual([1, 3, 5]);
    expect(result.even).toEqual([2, 4]);
  });

  it('matches the native implementation on mixed keys', () => {
    if (!nativeDescriptor) return; // runtime without native groupBy to compare against
    const nativeGroupBy = nativeDescriptor.value as GroupBy;
    const sym = Symbol('s');
    const items = ['a', 'bb', 'cc', 'ddd', 'e', '__proto__', 'x'];
    const key = (s: string): PropertyKey =>
      s === '__proto__' ? '__proto__' : s === 'x' ? sym : s.length === 2 ? 2 : String(s.length);
    const expected = nativeGroupBy(items, key);
    const actual = O.groupBy!(items, key);
    expect(Reflect.ownKeys(actual)).toEqual(Reflect.ownKeys(expected));
    for (const k of Reflect.ownKeys(expected)) expect(actual[k]).toEqual(expected[k]);
    expect(actual[sym]).toEqual(['x']);
    expect(Object.getPrototypeOf(actual)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(actual, '__proto__')).toBe(true);
  });

  it('accepts any iterable and converts keys with ToPropertyKey once', () => {
    let calls = 0;
    const objKey = { toString: () => { calls++; return 'k'; } };
    const result = O.groupBy!(new Set(['p', 'q']), () => objKey as unknown as PropertyKey);
    expect(result.k).toEqual(['p', 'q']);
    expect(calls).toBe(2);
    expect(O.groupBy!('aba', (c) => c)).toEqual(Object.assign(Object.create(null), { a: ['a', 'a'], b: ['b'] }));
    expect(Object.keys(O.groupBy!([], () => 'x'))).toEqual([]);
  });

  it('throws TypeError like the spec', () => {
    expect(() => O.groupBy!(null as unknown as Iterable<number>, () => 'x')).toThrow(TypeError);
    expect(() => O.groupBy!(undefined as unknown as Iterable<number>, () => 'x')).toThrow(TypeError);
    expect(() => O.groupBy!([1], 'x' as unknown as () => PropertyKey)).toThrow(TypeError);
    expect(() => O.groupBy!({ length: 1, 0: 1 } as unknown as Iterable<number>, () => 'x')).toThrow(TypeError);
  });

  it('closes the iterator when the callback throws', () => {
    let closed = false;
    const iterable: Iterable<number> = {
      [Symbol.iterator]() {
        let i = 0;
        return {
          next: () => ({ value: i++, done: false }),
          return: () => { closed = true; return { value: undefined, done: true }; },
        };
      },
    };
    expect(() => O.groupBy!(iterable, (n) => { if (n === 2) throw new Error('boom'); return 'k'; })).toThrow('boom');
    expect(closed).toBe(true);
  });

  it('does not replace a native implementation', () => {
    const marker = function groupBy() { return 'native'; };
    Object.defineProperty(Object, 'groupBy', { value: marker, writable: true, configurable: true });
    installObjectGroupByPolyfill();
    expect(O.groupBy).toBe(marker);
  });
});

// Mock mermaid module
vi.mock('mermaid', () => {
  let runCalls: Array<{ nodes: HTMLElement[] }> = [];
  const mockModule = {
    default: {
      initialize: vi.fn(),
      run: vi.fn(async (options: { nodes: HTMLElement[] }) => {
        runCalls.push(options);
        for (const node of options.nodes) {
          const source = node.dataset.mermaidSrc || node.textContent || '';
          node.innerHTML = `<svg data-source="${source}">rendered</svg>`;
        }
      }),
      _runCalls: () => runCalls,
      _clearRunCalls: () => { runCalls = []; },
    },
  };
  return mockModule;
});

import { MermaidLoader } from '../mermaid-loader';

describe('MermaidLoader cache', () => {
  const CACHE_MAX = 64;
  let mermaid: any;

  beforeEach(async () => {
    const mod = await import('mermaid');
    mermaid = mod.default;
    mermaid._clearRunCalls();
    vi.clearAllMocks();
  });

  function makeLoader() {
    return new MermaidLoader();
  }

  function makeContainer(sources: string[]) {
    const container = document.createElement('div');
    sources.forEach((src) => {
      const node = document.createElement('div');
      node.className = 'mermaid';
      node.textContent = src;
      container.appendChild(node);
    });
    return container;
  }

  it('keys cache by full source string to prevent collisions', async () => {
    const loader = makeLoader();
    await loader.ensureLoaded();

    // Render "Aa" and "BB" separately (hash collision under 31*h+c)
    const container1 = makeContainer(['Aa']);
    await loader.renderAll(container1);
    const svg1 = container1.querySelector('svg')?.outerHTML || '';

    const container2 = makeContainer(['BB']);
    await loader.renderAll(container2);
    const svg2 = container2.querySelector('svg')?.outerHTML || '';

    // They must have rendered separately (2 mermaid.run calls)
    expect(mermaid._runCalls().length).toBe(2);
    expect(svg1).toContain('data-source="Aa"');
    expect(svg2).toContain('data-source="BB"');

    // Re-render "Aa" from cache (no new run call)
    mermaid._clearRunCalls();
    const container3 = makeContainer(['Aa']);
    await loader.renderAll(container3);
    expect(mermaid._runCalls().length).toBe(0); // served from cache
    expect(container3.querySelector('svg')?.outerHTML).toContain('data-source="Aa"');
  });

  it('evicts least recently used entry at 65th insert', async () => {
    const loader = makeLoader();
    await loader.ensureLoaded();

    // Fill cache with CACHE_MAX distinct sources
    const sources = Array(CACHE_MAX)
      .fill(0)
      .map((_, i) => `graph${i}`);

    for (const src of sources) {
      const container = makeContainer([src]);
      await loader.renderAll(container);
    }

    expect(mermaid._runCalls().length).toBe(CACHE_MAX);
    mermaid._clearRunCalls();

    // Insert 65th diagram (should evict the oldest, which is sources[0])
    const container = makeContainer(['new']);
    await loader.renderAll(container);
    expect(mermaid._runCalls().length).toBe(1);
    mermaid._clearRunCalls();

    // Re-render the first source; it was evicted, so it must re-run
    const container2 = makeContainer([sources[0]]);
    await loader.renderAll(container2);
    expect(mermaid._runCalls().length).toBe(1);
  });

  it('refreshes position on cache hit', async () => {
    const loader = makeLoader();
    await loader.ensureLoaded();

    // Insert first diagram
    const first = 'first';
    const container1 = makeContainer([first]);
    await loader.renderAll(container1);
    mermaid._clearRunCalls();

    // Fill cache with CACHE_MAX - 1 more diagrams
    for (let i = 0; i < CACHE_MAX - 1; i++) {
      const container = makeContainer([`mid${i}`]);
      await loader.renderAll(container);
    }
    mermaid._clearRunCalls();

    // Hit first diagram (moves it to end of LRU)
    const container2 = makeContainer([first]);
    await loader.renderAll(container2);
    expect(mermaid._runCalls().length).toBe(0); // still cached

    // Add one more to evict oldest (should be mid0, not first)
    const container3 = makeContainer(['last']);
    await loader.renderAll(container3);
    mermaid._clearRunCalls();

    // First should still be cached (it was refreshed)
    const container4 = makeContainer([first]);
    await loader.renderAll(container4);
    expect(mermaid._runCalls().length).toBe(0);

    // But mid0 should have been evicted
    const container5 = makeContainer(['mid0']);
    await loader.renderAll(container5);
    expect(mermaid._runCalls().length).toBe(1);
  });

  it('resetCache clears all entries', async () => {
    const loader = makeLoader();
    await loader.ensureLoaded();

    const container1 = makeContainer(['graph TD\nA-->B']);
    await loader.renderAll(container1);
    mermaid._clearRunCalls();

    loader.resetCache();

    // Re-render must run again (cache was cleared)
    const container2 = makeContainer(['graph TD\nA-->B']);
    await loader.renderAll(container2);
    expect(mermaid._runCalls().length).toBe(1);
  });

  it('updateTheme resets cache', async () => {
    const loader = makeLoader();
    await loader.ensureLoaded();

    const container1 = makeContainer(['graph TD\nA-->B']);
    await loader.renderAll(container1);
    mermaid._clearRunCalls();

    loader.updateTheme('dark');

    // Re-render must run again (cache was cleared)
    const container2 = makeContainer(['graph TD\nA-->B']);
    await loader.renderAll(container2);
    expect(mermaid._runCalls().length).toBe(1);
  });

  it('setBaseDir resets cache in PreviewPane', async () => {
    const { pane } = makeLivePane();
    pane.setBaseDir('/tmp/proj1');

    const container = document.createElement('div');
    pane.init(container);

    await pane.renderImmediateForExport('```mermaid\ngraph TD\nA-->B\n```');
    
    const loader = (pane as any).mermaidLoader;
    const cacheSize = loader.svgCache.size;
    expect(cacheSize).toBeGreaterThan(0);

    // setBaseDir should reset the cache
    pane.setBaseDir('/tmp/proj2');
    expect(loader.svgCache.size).toBe(0);
  });
});
