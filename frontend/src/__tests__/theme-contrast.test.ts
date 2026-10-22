import { describe, it, expect } from 'vitest';

// Vitest doesn't process CSS (`?raw` comes back empty), so read the files.
// The frontend has no Node types; type the one call used.
const { readFileSync } = (await import('node:fs' as string)) as {
  readFileSync(p: URL, enc: 'utf8'): string;
};
const themesCss = readFileSync(new URL('../styles/themes.css', import.meta.url), 'utf8');
const changesCss = readFileSync(new URL('../styles/changes.css', import.meta.url), 'utf8');

/**
 * The enabled Commit button's label must meet WCAG AA (4.5:1) on its fill in
 * both themes, and the disabled button must not reuse that fill. Computed
 * from the theme tokens in themes.css, so a token change re-checks it.
 */

function tokens(selector: string): Record<string, string> {
  const start = themesCss.indexOf(selector);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = themesCss.slice(themesCss.indexOf('{', start) + 1, themesCss.indexOf('\n}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function rule(selector: string): string {
  const re = new RegExp(`(^|\\n)${selector.replace(/[.:()]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const m = re.exec(changesCss);
  expect(m, selector).not.toBeNull();
  return m![2];
}

describe('theme contrast', () => {
  it('computes known WCAG ratios', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 1);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
  });

  it('the enabled Commit button paints --accent-fg on --accent', () => {
    const enabled = rule('.changes-git-commit');
    expect(enabled).toMatch(/background:\s*var\(--accent\)/);
    expect(enabled).toMatch(/color:\s*var\(--accent-fg\)/);
  });

  it('the disabled Commit button is an outline, not the accent fill', () => {
    const disabled = rule('.changes-git-commit:disabled');
    expect(disabled).toMatch(/background:\s*transparent/);
    expect(disabled).not.toMatch(/var\(--accent\)/);
  });

  for (const [name, sel] of [
    ['light', ":root,\n[data-theme='light']"],
    ['dark', "[data-theme='dark']"],
  ] as const) {
    it(`${name}: Commit label meets WCAG AA (4.5:1) and differs from the disabled look`, () => {
      const t = tokens(sel);
      expect(contrast(t['--accent-fg'], t['--accent'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['--accent-fg'], t['--accent-hover'])).toBeGreaterThanOrEqual(4.5);
      // Disabled sits on the panel background; the enabled fill must stand
      // clearly apart from it.
      expect(contrast(t['--accent'], t['--bg'])).toBeGreaterThanOrEqual(3);
    });

    it(`${name}: a git error in the status bar meets WCAG AA`, () => {
      const t = tokens(sel);
      expect(contrast(t['--status-warning'], t['--statusbar-bg'])).toBeGreaterThanOrEqual(4.5);
    });
  }
});
