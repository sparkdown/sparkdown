"""Unit tests for geometry.py. Run: python3 -m unittest discover -s e2e/lib -p 'test_*.py'"""
import unittest

import geometry

SCREEN = (1920, 1080)


def g(w, h, maximized=True, x=0, y=0):
    return {"x": x, "y": y, "width": w, "height": h, "maximized": maximized}


class WaitStable(unittest.TestCase):
    def run_wait(self, values, need=3, timeout=10.0):
        it = iter(values)
        t = [0.0]

        def sample():
            return next(it, values[-1])

        def sleep(s):
            t[0] += s

        return geometry.wait_stable(sample, need=need, timeout=timeout, interval=1.0, sleep=sleep, clock=lambda: t[0])

    def test_stable_after_settling(self):
        ok, val, polls = self.run_wait(["a", "b", "c", "c", "c"])
        self.assertEqual((ok, val, polls), (True, "c", 5))

    def test_change_restarts_the_count(self):
        ok, val, polls = self.run_wait(["a", "a", "b", "b", "a", "a", "a"])
        self.assertEqual((ok, val, polls), (True, "a", 7))

    def test_none_never_counts(self):
        ok, val, _ = self.run_wait([None, None, None, None], timeout=5.0)
        self.assertFalse(ok)
        self.assertIsNone(val)

    def test_times_out_when_it_keeps_moving(self):
        ok, _, polls = self.run_wait([str(i) for i in range(100)], timeout=5.0)
        self.assertFalse(ok)
        self.assertEqual(polls, 6)


class CompareSaved(unittest.TestCase):
    def test_identical(self):
        a = {"w1": g(1920, 1080), "w2": g(933, 1038)}
        self.assertEqual(geometry.compare_saved(a, dict(a), SCREEN, True)[0], "same")

    def test_243_swap_of_tiles_between_maximized_windows(self):
        a = {"w1": g(1920, 1080), "w2": g(933, 1038)}
        b = {"w1": g(933, 1038), "w2": g(1920, 1080)}
        self.assertEqual(geometry.compare_saved(a, b, SCREEN, True)[0], "tiled")
        self.assertEqual(geometry.compare_saved(a, b, SCREEN, False)[0], "diff")
        self.assertEqual(geometry.compare_saved(a, b, None, True)[0], "diff")

    def test_243_940_vs_933(self):
        a = {"w1": g(940, 1040)}
        b = {"w1": g(933, 1038)}
        self.assertEqual(geometry.compare_saved(a, b, SCREEN, True)[0], "tiled")

    def test_unmaximized_size_change_is_a_failure(self):
        a = {"w1": g(900, 700, maximized=False)}
        b = {"w1": g(910, 720, maximized=False)}
        self.assertEqual(geometry.compare_saved(a, b, SCREEN, True)[0], "diff")

    def test_losing_the_maximized_flag_is_a_failure(self):
        a = {"w1": g(1920, 1080)}
        b = {"w1": g(933, 1038, maximized=False)}
        self.assertEqual(geometry.compare_saved(a, b, SCREEN, True)[0], "diff")

    def test_growth_past_the_screen_is_a_failure(self):
        a = {"w1": g(1920, 1080)}
        b = {"w1": g(1980, 1120)}
        self.assertEqual(geometry.compare_saved(a, b, SCREEN, True)[0], "diff")

    def test_position_change_is_a_failure(self):
        a = {"w1": g(933, 1038)}
        b = {"w1": g(933, 1038, x=966)}
        self.assertEqual(geometry.compare_saved(a, b, SCREEN, True)[0], "diff")

    def test_window_set_change_is_a_failure(self):
        a = {"w1": g(933, 1038), "w2": g(933, 1038)}
        b = {"w1": g(933, 1038)}
        self.assertEqual(geometry.compare_saved(a, b, SCREEN, True)[0], "diff")

    def test_missing_geometry_is_a_failure(self):
        self.assertEqual(geometry.compare_saved({"w1": None}, {"w1": g(1, 1)}, SCREEN, True)[0], "diff")


if __name__ == "__main__":
    unittest.main()
