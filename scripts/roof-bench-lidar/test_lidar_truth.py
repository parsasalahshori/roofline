"""Hermetic tests of the lidar truth builder on a synthetic house (no network, no clock, seeded randomness).

A 12 m x 8 m gable roof (6/12, eave 3 m) on flat ground, sampled at 12 pulses per m2 with 3 cm noise, under a leaf-off
crown on its east side: branch returns 4-9 m up, and under them the pulses that got through end on the roof (last
returns) or the ground. Google's height map sees the crown, not the roof edge. The truth must find the whole roof,
including the stretch under the crown, at both lidar densities used by 3DEP (QL1 8+ and denser).

Run: /Users/parsasalahshori-a/RooflineWork/venv/bin/python -I -m pytest scripts/roof-bench-lidar  (or python -I this file)
"""
import json, math, os, sys, tempfile, unittest
import numpy as np
import tifffile

HERE = os.path.dirname(os.path.abspath(__file__))
E0, N0, ZONE_EPSG = 563_000.0, 3_845_800.0, 32615


def make_bench(root, density=12.0, seed=7, second=True):
    """A bench folder with one house: lidar/<slug>/units/U/{points.npz,fetch.json}, testset/<slug>/{dsm.tif,bi.json}."""
    from pyproj import Transformer
    rng = np.random.default_rng(seed)
    slug = 'tr-synthetic'
    to_ll = Transformer.from_crs(ZONE_EPSG, 4326, always_xy=True)
    cx, cy = E0 + 35.0, N0 + 35.0  # house centre = crop centre
    n = int(70 * 70 * density)
    x = rng.uniform(cx - 35, cx + 35, n)
    y = rng.uniform(cy - 35, cy + 35, n)
    z = np.full(n, 100.0)
    cls = np.full(n, 2, np.uint8)
    rn = np.ones(n, np.uint8)
    nr = np.ones(n, np.uint8)
    on = (np.abs(x - cx) <= 6) & (np.abs(y - cy) <= 4)
    z[on] = 103.0 + 0.5 * (4 - np.abs(y[on] - cy))  # gable along x, 6/12, eave at 3 m
    cls[on] = 1
    # a neighbour 16 m west with its ridge north-south, in the open: it pins the frame along the house's ridge
    nb = second & (np.abs(x - (cx - 18)) <= 4) & (np.abs(y - cy) <= 6)
    z[nb] = 102.5 + 0.5 * (4 - np.abs(x[nb] - (cx - 18)))
    cls[nb] = 1
    # leaf-off crown over the east third: branch returns above, then the pulse ends on the roof or the ground
    crown = (x > cx + 2) & (x < cx + 9) & (np.abs(y - cy) < 6)
    k = np.nonzero(crown)[0]
    xb, yb = x[k], y[k]
    zb = 104.0 + rng.uniform(0, 5, len(k)) + (z[k] - 100.0)
    x = np.concatenate([x, xb]); y = np.concatenate([y, yb]); z = np.concatenate([z, zb])
    cls = np.concatenate([cls, np.ones(len(k), np.uint8)])
    rn = np.concatenate([rn, np.ones(len(k), np.uint8)])
    nr_b = np.full(len(k), 2, np.uint8)
    nr[k] = 2
    rn[k] = 2  # the original sample is now the pulse's last return
    nr = np.concatenate([nr, nr_b])
    z = z + rng.normal(0, 0.03, len(z))
    d = f'{root}/lidar/{slug}/units/U'
    os.makedirs(d)
    np.savez_compressed(f'{d}/points.npz', x=x, y=y, z=z, cls=cls, rn=rn, nr=nr, t=np.full(len(z), 1.42e9 - 1e9), i=np.zeros(len(z), np.uint16))
    lng, lat = to_ll.transform(cx, cy)
    json.dump(dict(slug=slug, workunit='U', project='P', ql='QL 1', spec='s', collect=['2025-01-02', '2025-01-03'], leafOffUnit=True,
                   pointDates=['2025-01-02', '2025-01-02', '2025-01-02'], utmEpsg=ZONE_EPSG, halfM=35.0, points=int(len(z)),
                   source=dict(kind='tile'), credit='USGS 3DEP'), open(f'{d}/fetch.json', 'w'))
    # Google: 0.1 m height map of 60 m, roof heights + the crown at 108 m over the east part (it sees foliage there)
    h = f'{root}/testset/{slug}'
    os.makedirs(h)
    W = 600
    ox, oy = cx - 30, cy + 30
    cols = ox + (np.arange(W) + 0.5) * 0.1
    rows = oy - (np.arange(W) + 0.5) * 0.1
    X, Y = np.meshgrid(cols, rows)
    dsm = np.full((W, W), 100.0, np.float32)
    house = (np.abs(X - cx) <= 6) & (np.abs(Y - cy) <= 4)
    dsm[house] = (103.0 + 0.5 * (4 - np.abs(Y - cy)))[house]
    if second:
        nbh = (np.abs(X - (cx - 18)) <= 4) & (np.abs(Y - cy) <= 6)
        dsm[nbh] = (102.5 + 0.5 * (4 - np.abs(X - (cx - 18))))[nbh]
    dsm[(X > cx + 2) & (X < cx + 9) & (np.abs(Y - cy) < 6)] = 108.0
    tifffile.imwrite(f'{h}/dsm.tif', dsm, extratags=[(34264, 12, 16, (0.1, 0, 0, ox, 0, -0.1, 0, oy, 0, 0, 0, 0, 0, 0, 0, 1), False),
                                                      (34735, 3, 16, (1, 1, 2, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, ZONE_EPSG), False)])
    sw = to_ll.transform(cx - 6, cy - 4)
    ne = to_ll.transform(cx + 2, cy + 4)  # Google's box stops where the crown starts
    json.dump({'boundingBox': {'sw': {'longitude': sw[0], 'latitude': sw[1]}, 'ne': {'longitude': ne[0], 'latitude': ne[1]}}}, open(f'{h}/bi.json', 'w'))
    return slug, [lng, lat], d


class LidarTruthTest(unittest.TestCase):
    def run_truth(self, density, seed=7, second=True):
        root = tempfile.mkdtemp(prefix='lidar-truth-')
        os.environ['ROOF_BENCH_DIR'] = root
        sys.path.insert(0, HERE)
        import importlib
        import lidar_truth
        lt = importlib.reload(lidar_truth)
        slug, point, d = make_bench(root, density, seed, second)
        r = lt.run(slug, 'testset', point, d, write_png=False)
        with open(f'{d}/truth.json') as f:
            return r, f.read()

    def test_finds_the_roof_under_the_crown(self):
        for density in (12.0, 25.0):
            r, _ = self.run_truth(density)
            self.assertTrue(r['ok'], r)
            # 96 m2 plan; the outline grows by half a spacing, so allow that band round 40 m of perimeter
            self.assertAlmostEqual(r['planAreaM2'], 96.0, delta=96 * 0.06)
            self.assertEqual(r['mainPitchX12'], 6)
            self.assertGreater(r['checks']['edgeObservedShare'], 0.85)

    def test_frame_registration_finds_no_shift_when_there_is_none(self):
        r, _ = self.run_truth(12.0)
        self.assertLess(abs(r['frame']['dxM']), 0.15)
        self.assertLess(abs(r['frame']['dyM']), 0.15)
        self.assertTrue(r['frame']['conditioned'])

    def test_a_lone_gable_does_not_pin_the_frame_and_says_so(self):
        # one gable, its east end under a crown: nothing fixes the shift along the ridge
        r, _ = self.run_truth(12.0, second=False)
        if abs(r['frame']['dxM']) > 0.15:
            self.assertFalse(r['frame']['conditioned'])

    def test_deterministic(self):
        _, a = self.run_truth(12.0, seed=3)
        _, b = self.run_truth(12.0, seed=3)
        self.assertEqual(a, b)


if __name__ == '__main__':
    unittest.main()
