/**
 * Fuzzy matching for the command palette / quick open.
 *
 * A query matches a target when its characters appear in order
 * (case-insensitive subsequence). Among matches, the score prefers, in
 * order of weight: an exact name, a name prefix, a contiguous substring,
 * then characters at segment starts ("/", "-", "_", ".", " ", camelCase)
 * and runs of consecutive characters. Shorter paths win ties; titles keep
 * their registration order.
 *
 * Paths are aligned inside the basename first, and over the whole path only
 * when the name alone does not match, so "agcon" finds "agent-context.md"
 * by name before "a/g/c/o/n.md".
 *
 * Fast enough for 50k paths per keystroke: FuzzyIndex lowercases once,
 * rejects non-matches with a plain subsequence scan, and a query that
 * extends the previous one only rescans the previous matches.
 */

const SCORE_CHAR = 16;
const BONUS_SEGMENT = 30; // after "/" or at 0
const BONUS_WORD = 22; // after - _ . space, or a camelCase hump
const BONUS_CONSECUTIVE = 18;
const PENALTY_GAP_START = 4;
const PENALTY_GAP_CHAR = 1;
const BONUS_IN_NAME = 40;
const BONUS_SUBSTRING = 150;
const BONUS_PREFIX = 400;
const BONUS_EXACT = 1000;
const NO_MATCH = -Infinity;

export interface Scored {
  score: number;
  /** Matched character indices into the target (ascending). */
  positions: number[];
}

function isSep(c: number): boolean {
  // - _ . space
  return c === 45 || c === 95 || c === 46 || c === 32;
}

function boundaryBonus(target: string, i: number): number {
  if (i === 0) return BONUS_SEGMENT;
  const prev = target.charCodeAt(i - 1);
  if (prev === 47 /* / */ || prev === 92 /* \ */) return BONUS_SEGMENT;
  if (isSep(prev)) return BONUS_WORD;
  const cur = target.charCodeAt(i);
  // camelCase: lower → Upper
  if (prev >= 97 && prev <= 122 && cur >= 65 && cur <= 90) return BONUS_WORD;
  return 0;
}

/**
 * fzf-v1 style alignment of `q` (lowercase) in `lower` from `from`: the
 * first window where q is a subsequence, tightened from its end. Fills
 * `out` with positions and returns the score, or NO_MATCH.
 */
function align(q: string, target: string, lower: string, from: number, out: number[] | null): number {
  const n = lower.length;
  const m = q.length;
  // Forward: the earliest end.
  let qi = 0;
  let end = -1;
  for (let i = from; i < n; i++) {
    if (lower.charCodeAt(i) === q.charCodeAt(qi)) {
      qi++;
      if (qi === m) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return NO_MATCH;
  // Backward: the latest start for that end (shortest window).
  qi = m - 1;
  let start = end;
  for (let i = end; i >= from; i--) {
    if (lower.charCodeAt(i) === q.charCodeAt(qi)) {
      start = i;
      if (--qi < 0) break;
    }
  }
  // Forward again inside the window, preferring boundary positions: take a
  // later occurrence of the same char when it sits on a boundary and the
  // rest of the query still fits (cheap lookahead, one char).
  let score = 0;
  let prevPos = -2;
  let i = start;
  for (qi = 0; qi < m; qi++) {
    const c = q.charCodeAt(qi);
    while (lower.charCodeAt(i) !== c) i++;
    let pos = i;
    if (prevPos !== pos - 1 && boundaryBonus(target, pos) === 0) {
      // Look for the same char on a boundary before the next query char's
      // first position at or after it — keeps the match valid.
      const next = qi + 1 < m ? q.charCodeAt(qi + 1) : -1;
      for (let j = pos + 1; j <= end; j++) {
        const cj = lower.charCodeAt(j);
        if (cj === c && boundaryBonus(target, j) > 0) {
          pos = j;
          break;
        }
        if (cj === next) break;
      }
    }
    const bonus = boundaryBonus(target, pos);
    if (pos === prevPos + 1) {
      score += SCORE_CHAR + BONUS_CONSECUTIVE + (bonus > 0 ? bonus : 0);
    } else {
      if (prevPos >= 0) score -= PENALTY_GAP_START + Math.min(pos - prevPos - 1, 20) * PENALTY_GAP_CHAR;
      score += SCORE_CHAR + bonus;
    }
    if (out) out.push(pos);
    prevPos = pos;
    i = pos + 1;
  }
  return score;
}

/** Index of the first character of the last path segment. */
export function basenameStart(path: string): number {
  const i = path.lastIndexOf('/');
  return i + 1;
}

/**
 * Score `target` against `query` (lowercase). `lower` = target.toLowerCase();
 * `nameStart` = basename offset (0 for plain titles). Returns null for no
 * match. `preferShort` breaks ties toward shorter targets (paths); titles
 * keep their list order instead.
 */
export function scoreTarget(
  query: string,
  target: string,
  lower: string,
  nameStart: number,
  preferShort = true,
): Scored | null {
  const positions: number[] = [];
  const score = scoreInto(query, target, lower, nameStart, positions);
  if (score === NO_MATCH) return null;
  return { score: preferShort ? score - lengthTieBreak(lower) : score, positions };
}

/**
 * The scorer. `out` = null skips positions (the ranking pass, which runs
 * for every candidate on every keystroke: no allocation, no slicing).
 * Returns NO_MATCH when `query` is not a subsequence of `target`.
 */
function scoreInto(query: string, target: string, lower: string, nameStart: number, out: number[] | null): number {
  const m = query.length;
  if (m === 0) return 0;
  if (m > lower.length) return NO_MATCH;

  // The name first: a match inside it is what the user almost always
  // means, and it saves the full-path pass on most candidates. A query
  // with "/" spans segments, so it cannot sit inside the name alone.
  let best = NO_MATCH;
  let positions: number[] | null = null;
  if (nameStart > 0 && query.indexOf('/') < 0) {
    positions = out ? [] : null;
    best = align(query, target, lower, nameStart, positions);
    if (best !== NO_MATCH) best += BONUS_IN_NAME;
  }
  if (best === NO_MATCH) {
    positions = out ? [] : null;
    best = align(query, target, lower, 0, positions);
    if (best === NO_MATCH) return NO_MATCH;
  }

  let run = -1; // start of a contiguous match that replaces the alignment
  const namePrefix = lower.startsWith(query, nameStart);
  if (namePrefix && lower.length - nameStart === m) {
    best += BONUS_EXACT;
    run = nameStart;
  } else if (lower.length === m && lower === query) {
    best += BONUS_EXACT;
    run = 0;
  } else if (namePrefix) {
    best += BONUS_PREFIX;
    run = nameStart;
  } else {
    const at = lower.indexOf(query);
    if (at >= 0) {
      // Prefer a copy inside the name over one in the directory part.
      const p = at >= nameStart ? at : lower.indexOf(query, nameStart);
      if (p >= 0) {
        best += BONUS_SUBSTRING + boundaryBonus(target, p);
        run = p;
      } else {
        best += BONUS_SUBSTRING / 2 + boundaryBonus(target, at);
        run = at;
      }
    }
  }
  if (out) {
    if (run >= 0) for (let i = 0; i < m; i++) out.push(run + i);
    else if (positions) for (const p of positions) out.push(p);
  }
  return best;
}

/** Shorter paths win ties; tiny compared to any bonus. */
const lengthTieBreak = (lower: string) => lower.length * 0.05;

export interface Ranked<T> {
  item: T;
  score: number;
  positions: number[];
}

/**
 * A searchable list (file paths or command titles) with the lowercase
 * forms precomputed and incremental narrowing between keystrokes.
 */
export class FuzzyIndex<T> {
  private readonly texts: string[];
  private readonly lowers: string[];
  private readonly nameStarts: Int32Array;
  private lastQuery = '';
  private lastMatches: Int32Array | null = null;

  constructor(
    private readonly items: readonly T[],
    textOf: (item: T) => string,
    /** true = path (basename-aware, spaces ignored); false = plain title. */
    private readonly paths = true,
  ) {
    const n = items.length;
    this.texts = new Array(n);
    this.lowers = new Array(n);
    this.nameStarts = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const t = textOf(items[i]);
      this.texts[i] = t;
      this.lowers[i] = t.toLowerCase();
      this.nameStarts[i] = paths ? basenameStart(t) : 0;
    }
  }

  get size(): number {
    return this.items.length;
  }

  /** Best `limit` matches for `query`, best first. */
  search(rawQuery: string, limit: number): Ranked<T>[] {
    const query = (this.paths ? rawQuery.replace(/\s+/g, '') : rawQuery.trim().replace(/\s+/g, ' ')).toLowerCase();
    if (!query) {
      this.lastQuery = '';
      this.lastMatches = null;
      return [];
    }
    // Narrow from the previous result when the query only grew.
    const narrowing = this.lastMatches && this.lastQuery && query.startsWith(this.lastQuery);
    const candidates = narrowing ? this.lastMatches! : null;
    const count = candidates ? candidates.length : this.items.length;
    const matched = new Int32Array(count);
    let matchedN = 0;

    // Top-k by score (ascending insertion into a small array).
    const topIdx: number[] = [];
    const topScore: number[] = [];
    for (let k = 0; k < count; k++) {
      const i = candidates ? candidates[k] : k;
      let score = scoreInto(query, this.texts[i], this.lowers[i], this.nameStarts[i], null);
      if (score === NO_MATCH) continue;
      if (this.paths) score -= lengthTieBreak(this.lowers[i]);
      matched[matchedN++] = i;
      if (topIdx.length < limit || score > topScore[topScore.length - 1]) {
        let lo = 0;
        let hi = topScore.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (topScore[mid] >= score) lo = mid + 1;
          else hi = mid;
        }
        topIdx.splice(lo, 0, i);
        topScore.splice(lo, 0, score);
        if (topIdx.length > limit) {
          topIdx.pop();
          topScore.pop();
        }
      }
    }
    this.lastQuery = query;
    this.lastMatches = matched.subarray(0, matchedN);

    return topIdx.map((i) => {
      const s = scoreTarget(query, this.texts[i], this.lowers[i], this.nameStarts[i], this.paths)!;
      return { item: this.items[i], score: s.score, positions: s.positions };
    });
  }
}
