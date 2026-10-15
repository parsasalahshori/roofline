"""Export each house's lidar point crop as the product-side input of the lidar hidden-edge method (outline-lidar.ts).

This is NOT the truth. It picks one project per house by a rule a server could apply from metadata alone (no truth
check, no Google data, no EagleView): leaf-off work units first, then the most recent flight, then the most points.
Writes ROOF_BENCH_DIR/lidar-edges/<slug>.bin and <slug>.json:

  .bin: little-endian, N records of 13 bytes: float32 dx, dy (metres east/north of the json's origin, UTM of the
        json's EPSG), float32 z (metres, the project's vertical datum), uint8 flags (bit 0: last return, bit 1: class 2
        ground). Noise classes (7, 18) are dropped.
  .json: {slug, workunit, project, ql, utmEpsg, originE, originN, count, leafOff, flightEnd, pointDates, fetchKind,
          fetchBytes, cropBytes}

Usage: python -I scripts/roof-bench-lidar/edge_points.py [ROOF_BENCH_DIR]
"""
import json
import os
import sys

import numpy as np

BENCH = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('ROOF_BENCH_DIR', '/Users/parsasalahshori-a/RooflineWork/roof-bench')
LIDAR = os.path.join(BENCH, 'lidar')
OUT = os.path.join(BENCH, 'lidar-edges')
NOISE = (7, 18)


def unit_key(f):
    # Leaf-off first, then the latest flight end, then the most points: metadata a server has before reading points.
    return (1 if f.get('leafOffUnit') else 0, (f.get('collect') or [''])[-1] or '', f.get('points', 0), f['workunit'])


def main():
    os.makedirs(OUT, exist_ok=True)
    tiles_bytes = {}
    n = 0
    for slug in sorted(os.listdir(LIDAR)):
        units = os.path.join(LIDAR, slug, 'units')
        if not os.path.isdir(units):
            continue
        cands = []
        for wu in sorted(os.listdir(units)):
            fj = os.path.join(units, wu, 'fetch.json')
            pz = os.path.join(units, wu, 'points.npz')
            if os.path.exists(fj) and os.path.exists(pz):
                cands.append((json.load(open(fj)), pz))
        if not cands:
            continue
        meta, pz = max(cands, key=lambda c: unit_key(c[0]))
        z = np.load(pz)
        keep = ~np.isin(z['cls'], NOISE)
        x, y, h = z['x'][keep], z['y'][keep], z['z'][keep] * float(meta['source'].get('zUnitsToM', 1.0))
        last = (z['rn'][keep] >= z['nr'][keep]).astype(np.uint8)
        ground = (z['cls'][keep] == 2).astype(np.uint8)
        oe, on = float(np.floor(x.min())), float(np.floor(y.min()))
        rec = np.zeros(x.size, dtype=[('dx', '<f4'), ('dy', '<f4'), ('z', '<f4'), ('f', 'u1')])
        rec['dx'] = x - oe
        rec['dy'] = y - on
        rec['z'] = h
        rec['f'] = last | (ground << 1)
        # Deterministic order: by y, then x (the crop's own order already is, but make it explicit).
        rec = rec[np.lexsort((rec['dx'], rec['dy']))]
        rec.tofile(os.path.join(OUT, slug + '.bin'))
        src = meta['source']
        fetch_bytes = src.get('bytes') if src['kind'] == 'ept' else sum(t.get('bytes', 0) for t in src.get('tiles', []))
        info = {
            'slug': slug, 'workunit': meta['workunit'], 'project': meta['project'], 'ql': meta.get('ql'),
            'utmEpsg': meta['utmEpsg'], 'originE': oe, 'originN': on, 'count': int(rec.size),
            'leafOff': bool(meta.get('leafOffUnit')), 'flightEnd': (meta.get('collect') or [None])[-1],
            'pointDates': meta.get('pointDates'), 'fetchKind': src['kind'], 'fetchBytes': fetch_bytes,
            'eptNodes': src.get('nodes'), 'cropBytes': int(rec.size * 13),
        }
        with open(os.path.join(OUT, slug + '.json'), 'w') as f:
            json.dump(info, f, indent=1, sort_keys=True)
        n += 1
    print(f'{n} houses written to {OUT}')


if __name__ == '__main__':
    main()
