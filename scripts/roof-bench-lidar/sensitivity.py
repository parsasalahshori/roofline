"""Sensitivity of the lidar truth to its own constants: each moved by -20 % and +20 %, on the DEV houses only.

For every constant and factor the truth is rebuilt (on each house's chosen work unit) into a scratch folder, never over
the real truth, and compared with the truth in use: how many houses the checks accept (A1-A5), the median IoU of the
moved outline with the one in use (accepted houses), and the median aligned IoU with EagleView of the EagleView houses
the checks accept. Usage: python -I sensitivity.py SCRATCH_DIR
"""
import json, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lidar_truth as lt  # noqa: E402
import validate as va  # noqa: E402
from pyproj import Transformer  # noqa: E402

CONSTANTS = ['PLANAR_RMS_M', 'GROW_ANGLE_DEG', 'GROW_DIST_M', 'ATTACH_DIST_M', 'LINK_M', 'MAX_STEP_M', 'NECK_M', 'BIG_PLANE_M2', 'MIN_CLOSE_M', 'MIN_HAG_M', 'EDGE_DROP_M']
R, L = lt.R, lt.L


def houses():
    m = json.load(open(f'{R}/manifest.json'))
    out = []
    for h in m['houses']:
        p = f'{L}/{h["slug"]}/truth.json'
        if h['split'] != 'dev' or not os.path.exists(p):
            continue
        t = json.load(open(p))
        if t.get('ok') and t.get('unit'):
            out.append((h, t['unit']))
    return out


def job(args):
    const, factor, scratch = args
    base = getattr(lt, const)
    setattr(lt, const, type(base)(base * factor) if not isinstance(base, int) else max(1, int(round(base * factor))))
    res = {}
    for h, unit in houses():
        d = f'{L}/{h["slug"]}/units/{unit}'
        out = f'{scratch}/{const}-{factor}-{h["slug"]}.json'
        try:
            r = lt.run(h['slug'], h['set'], h['point'], d, write_png=False, out_path=out)
        except Exception as e:  # noqa: BLE001
            r = dict(ok=False, reason=str(e))
        res[h['slug']] = out if r.get('ok') else None
    setattr(lt, const, base)
    return const, factor, res


def summary(paths):
    acc, ious, evs = 0, [], []
    for h, _ in houses():
        p = paths.get(h['slug'])
        base = json.load(open(f'{L}/{h["slug"]}/truth.json'))
        if p is None:
            continue
        t = json.load(open(p))
        tr = Transformer.from_crs(4326, va.utm_of(*h['point']), always_xy=True)
        evp = f'{R}/{h["dir"]}/eagleview.json'
        evc = va.ev_compare(t, json.load(open(evp)), tr) if os.path.exists(evp) else None
        ok = not va.grade(t, None)
        acc += ok
        if ok:
            ious.append(va.iou(va.lidar_poly(tr, t), va.lidar_poly(tr, base)))
            if evc is not None and evc['structures'] == 1:
                evs.append(evc['iouAligned'])
    return acc, (float(np.median(ious)) if ious else None), (float(np.median(evs)) if evs else None), len(evs)


def main(args):
    """sensitivity.py SCRATCH            every constant and factor, one process each (8 at a time), then the table
       sensitivity.py SCRATCH C F        one constant at one factor (what the first form runs)"""
    import subprocess
    scratch = args[0]
    os.makedirs(scratch, exist_ok=True)
    if len(args) == 3:
        const, factor, res = job((args[1], float(args[2]), scratch))
        json.dump(res, open(f'{scratch}/{const}-{factor}.index.json', 'w'))
        return
    tasks = [(c, f) for c in CONSTANTS for f in (0.8, 1.2)]
    running = []
    for c, f in tasks:
        running.append(subprocess.Popen([sys.executable, '-I', os.path.abspath(__file__), scratch, c, str(f)]))
        while len([p for p in running if p.poll() is None]) >= 8:
            running[[p.poll() is None for p in running].index(True)].wait()
    for p in running:
        p.wait()
    base_paths = {h['slug']: f'{L}/{h["slug"]}/truth.json' for h, _ in houses()}
    a, i, e, n = summary(base_paths)
    print('| constants | houses passing A1-A5 | median IoU with the truth in use | median aligned IoU vs EagleView (houses) |')
    print('| --- | --- | --- | --- |')
    print(f'| in use | {a} | {i:.3f} | {e:.3f} ({n}) |')
    for c, f in tasks:
        paths = json.load(open(f'{scratch}/{c}-{f}.index.json'))
        a, i, e, n = summary(paths)
        print(f"| {c} x{f} | {a} | {'-' if i is None else f'{i:.3f}'} | {'-' if e is None else f'{e:.3f}'} ({n}) |", flush=True)


if __name__ == '__main__':
    main(sys.argv[1:])
