/** Default / bounds for the terminal scrollback setting (lines). */
export const TERMINAL_SCROLLBACK_DEFAULT = 5000;
export const TERMINAL_SCROLLBACK_MIN = 200;
export const TERMINAL_SCROLLBACK_MAX = 50_000;

/** Clamp a config value into the allowed scrollback range. */
export function clampScrollback(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return TERMINAL_SCROLLBACK_DEFAULT;
  return Math.min(
    TERMINAL_SCROLLBACK_MAX,
    Math.max(TERMINAL_SCROLLBACK_MIN, Math.round(n)),
  );
}
