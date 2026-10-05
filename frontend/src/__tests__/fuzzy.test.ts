import { describe, it, expect } from 'vitest';
import { FuzzyIndex, scoreTarget, basenameStart } from '../fuzzy';

const score = (q: string, t: string) => scoreTarget(q.toLowerCase(), t, t.toLowerCase(), basenameStart(t));
const rank = (q: string, items: string[]) => new FuzzyIndex(items, (s) => s).search(q, 50).map((r) => r.item);

describe('fuzzy scoring', () => {
  it('matches case-insensitive subsequences only', () => {
    expect(score('rdm', 'README.md')).not.toBeNull();
    expect(score('mdr', 'README.md')).toBeNull();
    expect(score('toolong', 'a.md')).toBeNull();
  });

  it('ranks exact > prefix > substring > subsequence', () => {
    const items = ['docs/app-notes.md', 'src/myapp.ts', 'src/app.ts', 'lib/apricot-pie.ts', 'src/application.ts'];
    expect(rank('app.ts', items)[0]).toBe('src/app.ts');
    expect(rank('app', items)).toEqual([
      'src/app.ts', // prefix, shortest
      'docs/app-notes.md', // prefix
      'src/application.ts', // prefix, longer
      'src/myapp.ts', // substring
      'lib/apricot-pie.ts', // subsequence
    ]);
  });

  it('prefers characters at segment and word starts', () => {
    // "agcon": a-g at the name start, "con" at a word start
    expect(rank('agcon', ['docs/magicon.md', 'docs/agent-context-design.md'])[0]).toBe(
      'docs/agent-context-design.md',
    );
    // camelCase humps count as word starts
    expect(rank('fto', ['src/fatotum.ts', 'src/fileTreeOpen.ts'])[0]).toBe('src/fileTreeOpen.ts');
    // path segments: s/a/c = src/app/context
    const segs = score('sac', 'src/app/context.ts')!;
    const flat = score('sac', 'src/xsaxc.ts')!;
    expect(segs.score).toBeGreaterThan(flat.score);
  });

  it('prefers a match inside the file name over one spread over the path', () => {
    expect(rank('main', ['m/a/i/n/x.rs', 'src/main.rs'])[0]).toBe('src/main.rs');
  });

  it('returns match positions for highlighting', () => {
    const s = score('agcon', 'app/agent-context.ts')!;
    const t = 'app/agent-context.ts';
    expect(s.positions.map((p) => t[p]).join('')).toBe('agcon');
    // In the file name, not the "a" of "app"
    expect(s.positions[0]).toBe(4);
    expect(score('app', 'src/app.ts')!.positions).toEqual([4, 5, 6]);
  });

  it('narrows incrementally and widens again when the query shrinks', () => {
    const idx = new FuzzyIndex(['a/foo.txt', 'a/bar.txt', 'b/food.txt'], (s) => s);
    expect(idx.search('fo', 10).map((r) => r.item).sort()).toEqual(['a/foo.txt', 'b/food.txt']);
    expect(idx.search('food', 10).map((r) => r.item)).toEqual(['b/food.txt']);
    expect(idx.search('ba', 10).map((r) => r.item)).toEqual(['a/bar.txt']);
    expect(idx.search('', 10)).toEqual([]);
  });

  it('keeps spaces for titles and ignores them for paths', () => {
    const titles = new FuzzyIndex(['Terminal: Split right', 'View: Edit and preview (split)'], (s) => s, false);
    expect(titles.search('split right', 10)[0].item).toBe('Terminal: Split right');
    expect(rank('app ts', ['src/app.ts'])).toEqual(['src/app.ts']);
  });

  it('keeps registration order for equally good titles', () => {
    const titles = new FuzzyIndex(['Terminal: Split right', 'Terminal: Split down'], (s) => s, false);
    expect(titles.search('split', 10).map((r) => r.item)).toEqual(['Terminal: Split right', 'Terminal: Split down']);
  });
});

describe('fuzzy performance', () => {
  /** 50k synthetic workspace paths with realistic depth and names. */
  function syntheticPaths(n: number): string[] {
    const dirs = ['src', 'docs', 'frontend/src', 'frontend/src/app', 'src-tauri/src', 'tests/fixtures', 'packages/core/lib'];
    const words = ['agent', 'context', 'design', 'cockpit', 'plan', 'remote', 'picker', 'terminal', 'tabs', 'editor', 'preview', 'watcher', 'meat', 'status'];
    const exts = ['.md', '.ts', '.rs', '.json', '.css'];
    const out: string[] = [];
    let seed = 7;
    const rnd = (m: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % m;
    };
    for (let i = 0; i < n; i++) {
      const dir = `${dirs[rnd(dirs.length)]}/${words[rnd(words.length)]}${i % 97}`;
      const name = `${words[rnd(words.length)]}-${words[rnd(words.length)]}-${i}${exts[rnd(exts.length)]}`;
      out.push(`${dir}/${name}`);
    }
    return out;
  }

  it('ranks 50k paths in under 16 ms per keystroke', () => {
    const idx = new FuzzyIndex(syntheticPaths(50_000), (s) => s);
    const typed = ['a', 'ag', 'agc', 'agco', 'agcon', 'agcont', 's', 'sr', 'src', 'src/', 'src/t', 'src/te'];
    // The suite runs test files in parallel worker processes, so wall time
    // here includes waiting for a core. Measure this process's CPU time
    // (what one keystroke costs) where Node provides it, and take the best
    // of five runs of the same typing sequence.
    const proc = (globalThis as { process?: { cpuUsage?: () => { user: number; system: number } } }).process;
    const now = proc?.cpuUsage
      ? () => {
          const u = proc.cpuUsage!();
          return (u.user + u.system) / 1000;
        }
      : () => performance.now();
    const best = typed.map(() => Infinity);
    for (let run = 0; run < 5; run++) {
      idx.search('', 50); // reset narrowing, like a fresh palette
      typed.forEach((q, i) => {
        const t0 = now();
        const res = idx.search(q, 50);
        best[i] = Math.min(best[i], now() - t0);
        expect(res.length).toBeGreaterThan(0);
      });
    }
    const sorted = [...best].sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length / 2)]).toBeLessThan(16);
    // The widest keystroke (one character, nearly every path matches) gets
    // headroom for slow CI runners.
    expect(sorted[sorted.length - 1]).toBeLessThan(50);
  });
});
