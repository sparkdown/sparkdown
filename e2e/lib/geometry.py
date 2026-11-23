"""Geometry helpers for the geometry-stable check (#112, #154, #243).

Pure functions, no I/O, so they can be unit tested (test_geometry.py).
"""
import time


def wait_stable(sample, need=6, timeout=30.0, interval=0.5, sleep=time.sleep, clock=time.monotonic):
    """Poll `sample()` until it returns the same non-None value `need` times
    in a row, or `timeout` seconds pass.

    Returns (stable, last_value, polls). A different value (or None) restarts
    the count, so a window that is still being moved or resized by the
    compositor keeps the wait going.
    """
    deadline = clock() + timeout
    last, run, polls = None, 0, 0
    while True:
        value = sample()
        polls += 1
        if value is not None and value == last:
            run += 1
        else:
            run = 1 if value is not None else 0
        last = value
        if value is not None and run >= need:
            return True, value, polls
        if clock() >= deadline:
            return False, value, polls
        sleep(interval)


def _fits(g, screen):
    w, h = g.get("width") or 0, g.get("height") or 0
    return 0 < w <= screen[0] and 0 < h <= screen[1]


def compare_saved(a, b, screen=None, tiling=False):
    """Compare the saved geometry of two quits: {window id: geometry dict}.

    Returns ("same", "") when identical, ("tiled", note) when the only
    differences are the size of windows that are maximized in both, on a
    tiling compositor, or ("diff", why) otherwise.

    Why the maximized exemption (#243): Hyprland tiles a restored window
    (alone: 1878x1038, beside another window: 933x1038) before and while it
    reports it maximized, and which window is mapped first changes between
    relaunches, so the size kept for a maximized window is whichever tile it
    saw, not a restore size. What must stay exact: the same set of windows,
    the maximized flag, the position, and every size of a window that is not
    maximized. A maximized window's size must also stay a real, on-screen size
    (0 < size <= the monitor), which still catches growth past the screen.
    """
    if a == b:
        return "same", ""
    if not tiling or screen is None:
        return "diff", "sizes differ"
    if set(a) != set(b):
        return "diff", f"windows differ: {sorted(a)} vs {sorted(b)}"
    notes = []
    for k in sorted(a):
        ga, gb = a[k], b[k]
        if ga == gb:
            continue
        if not (ga and gb):
            return "diff", f"{k}: geometry missing in one quit"
        if not (ga.get("maximized") and gb.get("maximized")):
            return "diff", f"{k}: not maximized in both quits, so its size must not change"
        if (ga.get("x"), ga.get("y")) != (gb.get("x"), gb.get("y")):
            return "diff", f"{k}: position changed"
        if not (_fits(ga, screen) and _fits(gb, screen)):
            return "diff", f"{k}: maximized size outside the {screen[0]}x{screen[1]} monitor"
        notes.append(f"{k}: {ga['width']}x{ga['height']} -> {gb['width']}x{gb['height']}")
    return "tiled", "maximized windows saved at the compositor's tile size (not compared): " + "; ".join(notes)
