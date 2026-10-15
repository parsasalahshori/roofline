"""Hermetic tests of the free-source tools' geometry and pick rules (no network, no bench files).
Run: <venv>/bin/python -m unittest discover -s scripts/roof-bench-free/tests"""
import math, sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from geo import utm_for, to_xy, compare, best_shift  # noqa: E402
import county_truth  # noqa: E402

LNG, LAT = -92.3, 34.75
TR = utm_for(LNG, LAT)
INV = None


def ll_rect(x0, y0, x1, y1):
    """A rectangle in metres east/north of (LNG, LAT), as a lng/lat ring."""
    from pyproj import Transformer
    global INV
    if INV is None: INV = Transformer.from_crs(TR.target_crs, 4326, always_xy=True)
    ox, oy = TR.transform(LNG, LAT)
    pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]
    return [list(INV.transform(ox + x, oy + y)) for x, y in pts]


class GeoTests(unittest.TestCase):
    def test_identical_is_perfect(self):
        a = to_xy(TR, [ll_rect(0, 0, 12, 8)])
        m = compare(a, a)
        self.assertAlmostEqual(m["iou"], 1, 3)
        self.assertAlmostEqual(m["planErrPct"], 0, 2)

    def test_offset_removed_by_alignment(self):
        a = to_xy(TR, [ll_rect(0, 0, 12, 8)])
        b = to_xy(TR, [ll_rect(1, -0.5, 13, 7.5)])
        m = compare(a, b)
        self.assertLess(m["iou"], 0.85)
        self.assertGreater(m["alignedIoU"], 0.99)
        self.assertAlmostEqual(m["shiftM"][0], -1, 1)

    def test_shift_never_beyond_limit(self):
        a = to_xy(TR, [ll_rect(0, 0, 12, 8)])
        b = to_xy(TR, [ll_rect(10, 0, 22, 8)])
        _, dx, dy = best_shift(a, b)
        self.assertLessEqual(math.hypot(dx, dy), 3.0 + 1e-9)

    def test_missing_wing_is_negative_plan_error(self):
        a = to_xy(TR, [ll_rect(0, 0, 9, 8)])
        b = to_xy(TR, [ll_rect(0, 0, 12, 8)])
        self.assertAlmostEqual(compare(a, b)["planErrPct"], -25, 0)

    def test_deterministic(self):
        a = to_xy(TR, [ll_rect(0, 0, 12, 8)])
        b = to_xy(TR, [ll_rect(0.3, 0.2, 12.4, 8.1)])
        self.assertEqual(compare(a, b), compare(a, b))


class PickTests(unittest.TestCase):
    H = {"slug": "t", "lng": LNG, "lat": LAT}

    def feats(self, *rects, props=None):
        return [{"id": f"pagis/{i}", "rings": [ll_rect(*r)], "props": props or {}} for i, r in enumerate(rects)]

    def test_picks_the_footprint_under_the_point_and_its_attached_garage(self):
        parts, why = county_truth.pick("pagis", self.feats((-6, -4, 6, 4), (6, -4, 10, 0), (30, 30, 40, 40)), self.H, TR)
        self.assertIsNone(why)
        self.assertEqual(sorted(f["id"] for f, _ in parts), ["pagis/0", "pagis/1"])

    def test_nothing_near_the_point_is_refused(self):
        parts, why = county_truth.pick("pagis", self.feats((20, 20, 30, 30)), self.H, TR)
        self.assertIsNone(parts)
        self.assertEqual(why, "no-footprint-at-point")

    def test_machine_learning_rows_are_never_county_truth(self):
        parts, why = county_truth.pick("ny-its", self.feats((-6, -4, 6, 4), props={"SOURCE": "NYSERDA added Microsoft Building Footprints"}), self.H, TR)
        self.assertIsNone(parts)
        self.assertEqual(why, "no-footprint")


if __name__ == "__main__":
    unittest.main()
