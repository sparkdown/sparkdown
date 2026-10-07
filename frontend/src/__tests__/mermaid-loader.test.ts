import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installObjectGroupByPolyfill, mermaidConfig } from '../mermaid-loader';

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
    });
    expect(mermaidConfig('dark')).toMatchObject({ theme: 'dark', layout: 'dagre', look: 'classic' });
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
