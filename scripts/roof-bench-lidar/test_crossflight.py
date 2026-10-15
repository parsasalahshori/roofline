"""Hermetic tests of crossflight.py (roof-change check, truth tiers) and of edge_points.py's height units.

No network, no clock, seeded randomness. Run:
  /Users/parsasalahshori-a/RooflineWork/venv/bin/python -I -m pytest scripts/roof-bench-lidar   (or python -I this file)
"""
import json, os, subprocess, sys, tempfile, unittest
import numpy as np
from shapely.geometry import box

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import crossflight as xf  # noqa: E402


def flight(rng, density, roof_boxes, canopy=None, ground_z=100.0, roof_z=104.0):
    """Returns over a 40 m square: roof (class 1) inside roof_boxes, ground (class 2) elsewhere, and inside `canopy`
    only branch returns (class 1, high), no ground and no roof: a leaf-on crown the pulses do not get through."""
    n = int(40 * 40 * density)
    x = rng.uniform(-20, 20, n)
    y = rng.uniform(-20, 20, n)
    z = np.full(n, ground_z) + rng.normal(0, 0.03, n)
    cls = np.full(n, 2, np.uint8)
    for (x0, y0, x1, y1) in roof_boxes:
        on = (x >= x0) & (x <= x1) & (y >= y0) & (y <= y1)
        z[on] = roof_z + rng.normal(0, 0.03, on.sum())
        cls[on] = 1
    if canopy is not None:
        x0, y0, x1, y1 = canopy
        on = (x >= x0) & (x <= x1) & (y >= y0) & (y <= y1)
        z[on] = roof_z + 4 + rng.uniform(0, 3, on.sum())
        cls[on] = 1
    return (x, y, z, cls)


MAIN = (-6, -4, 6, 4)        # a 12 m x 8 m house
WING = (6, -3, 11, 3)        # a 5 m x 6 m wing to the east (30 m2)


class ChangeCheck(unittest.TestCase):
    def setUp(self):
        self.rng = np.random.default_rng(11)

    def test_same_roof_both_flights_is_no_change(self):
        a = flight(self.rng, 2.0, [MAIN])
        b = flight(self.rng, 10.0, [MAIN])
        r = xf.change_check(box(*MAIN), box(*MAIN), a, b, 0.48, 0.25)
        self.assertFalse(r['changed'], r)

    def test_a_wing_built_between_flights_is_a_change(self):
        # the older flight saw ground where the newer one has the wing
        a = flight(self.rng, 2.0, [MAIN])
        b = flight(self.rng, 10.0, [MAIN, WING])
        r = xf.change_check(box(*MAIN), box(*MAIN).union(box(*WING)), a, b, 0.48, 0.25)
        self.assertTrue(r['changed'], r)
        self.assertGreater(r['addedM2'], xf.MIN_CHANGE_M2)

    def test_a_wing_the_older_flight_could_not_see_is_not_a_change(self):
        # the wing stood all along; the older flight's pulses ended in a crown over it (no ground returns there)
        a = flight(self.rng, 2.0, [MAIN, WING], canopy=WING)
        b = flight(self.rng, 10.0, [MAIN, WING])
        r = xf.change_check(box(*MAIN), box(*MAIN).union(box(*WING)), a, b, 0.48, 0.25)
        self.assertFalse(r['changed'], r)

    def test_a_demolished_wing_is_a_change(self):
        a = flight(self.rng, 10.0, [MAIN, WING])
        b = flight(self.rng, 10.0, [MAIN])
        r = xf.change_check(box(*MAIN).union(box(*WING)), box(*MAIN), a, b, 0.25, 0.25)
        self.assertTrue(r['changed'], r)
        self.assertGreater(r['removedM2'], xf.MIN_CHANGE_M2)

    def test_a_new_storey_is_a_change(self):
        a = flight(self.rng, 8.0, [MAIN])
        b = flight(self.rng, 8.0, [MAIN], roof_z=107.0)
        r = xf.change_check(box(*MAIN), box(*MAIN), a, b, 0.25, 0.25)
        self.assertTrue(r['changed'], r)
        self.assertGreater(r['roofDzM'], xf.MAX_ROOF_DZ_M)

    def test_ground_returns_along_the_edge_band_are_not_a_change(self):
        # B's outline is 0.4 m wider all round (its grow); A's ground returns in that thin band must not count
        a = flight(self.rng, 2.0, [MAIN])
        b = flight(self.rng, 10.0, [MAIN])
        r = xf.change_check(box(*MAIN), box(*MAIN).buffer(0.4, join_style=2), a, b, 0.48, 0.25)
        self.assertFalse(r['changed'], r)

    def test_deterministic(self):
        a = flight(np.random.default_rng(3), 2.0, [MAIN])
        b = flight(np.random.default_rng(4), 10.0, [MAIN, WING])
        r1 = xf.change_check(box(*MAIN), box(*MAIN).union(box(*WING)), a, b, 0.48, 0.25)
        r2 = xf.change_check(box(*MAIN), box(*MAIN).union(box(*WING)), a, b, 0.48, 0.25)
        self.assertEqual(json.dumps(r1, sort_keys=True), json.dumps(r2, sort_keys=True))


class Tiers(unittest.TestCase):
    def test_tiers(self):
        self.assertEqual(xf.tier_of([], 0.25), 'fine')
        self.assertEqual(xf.tier_of(['A2-density'], 0.48), 'coarse')
        self.assertIsNone(xf.tier_of(['A2-density'], 0.6))
        self.assertIsNone(xf.tier_of(['A2-density', 'A3-edges-unobserved'], 0.4))
        self.assertIsNone(xf.tier_of(['A4-changed'], 0.2))


class EdgePointsHeights(unittest.TestCase):
    def test_heights_are_not_scaled_twice(self):
        # points.npz is metres already (fetch.py converted feet); the crop must keep them
        root = tempfile.mkdtemp(prefix='edge-points-')
        d = f'{root}/lidar/h/units/U'
        os.makedirs(d)
        z = np.array([100.0, 104.0, 101.0])
        np.savez_compressed(f'{d}/points.npz', x=np.array([1.0, 2.0, 3.0]), y=np.array([1.0, 2.0, 3.0]), z=z, cls=np.array([2, 1, 2], np.uint8),
                            rn=np.ones(3, np.uint8), nr=np.ones(3, np.uint8))
        json.dump(dict(workunit='U', project='P', ql='QL 1', utmEpsg=32615, leafOffUnit=True, collect=['2025-01-01', '2025-01-02'], points=3,
                       source=dict(kind='tile', zUnitsToM=0.3048006096, tiles=[])), open(f'{d}/fetch.json', 'w'))
        subprocess.run([sys.executable, '-I', f'{HERE}/edge_points.py', root], check=True, capture_output=True)
        rec = np.fromfile(f'{root}/lidar-edges/h.bin', dtype=[('dx', '<f4'), ('dy', '<f4'), ('z', '<f4'), ('f', 'u1')])
        self.assertEqual(sorted(rec['z'].tolist()), sorted(z.tolist()))

    def test_pick_xf_takes_only_flights_with_fine_cross_flight_truth(self):
        root = tempfile.mkdtemp(prefix='edge-points-xf-')
        for u, end in (('OLD', '2017-01-02'), ('NEW', '2025-01-02')):
            d = f'{root}/lidar/h/units/{u}'
            os.makedirs(d)
            np.savez_compressed(f'{d}/points.npz', x=np.array([1.0]), y=np.array([1.0]), z=np.array([100.0]), cls=np.array([2], np.uint8),
                                rn=np.ones(1, np.uint8), nr=np.ones(1, np.uint8))
            json.dump(dict(workunit=u, project=u, ql='QL 1', utmEpsg=32615, leafOffUnit=True, collect=['x', end], points=1,
                           source=dict(kind='tile', tiles=[])), open(f'{d}/fetch.json', 'w'))
        # by metadata alone NEW (latest) is picked; only OLD has a fine truth from another flight
        json.dump(dict(registry={'OLD': dict(truthUnit='NEW', tier='fine'), 'NEW': dict(truthUnit='OLD', tier='coarse')}), open(f'{root}/lidar/h/crossflight.json', 'w'))
        subprocess.run([sys.executable, '-I', f'{HERE}/edge_points.py', root], check=True, capture_output=True)
        subprocess.run([sys.executable, '-I', f'{HERE}/edge_points.py', root, '--pick', 'xf'], check=True, capture_output=True)
        self.assertEqual(json.load(open(f'{root}/lidar-edges/h.json'))['workunit'], 'NEW')
        self.assertEqual(json.load(open(f'{root}/lidar-edges-xf/h.json'))['workunit'], 'OLD')


if __name__ == '__main__':
    unittest.main()
