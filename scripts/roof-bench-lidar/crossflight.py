"""Cross-flight lidar truth: score a method that READS one lidar flight against truth built from a DIFFERENT flight.

Why: a method that fuses lidar into the outline (the fusion track) cannot be scored on lidar truth built from the same
returns (the truth would mark its own homework). Many benchmark houses are covered by two 3DEP projects of QL2 or
better (Arkansas: a 2015-2017 FEMA/Ouachita QL2 flight and the 2024-2025 AR_Western_B24 QL1 flight). lidar_truth.py
already builds an outline from each flight on its own (lidar/<slug>/units/<unit>/truth.json); this script

  1. grades every unit truth with validate.grade (rules A1-A6, EagleView only as the A6 cross-check, as for the
     primary truth), and marks a unit 'fine' (passes all) or 'coarse' (fails only A2-density and its expected edge
     error is <= COARSE_MAX_EDGE_ERROR_M: good for area/IoU, too coarse for the 0.5 m hidden-edge test);
  2. for every pair of flights compares the two outlines (IoU, plan areas, mean boundary distance) and looks for a ROOF
     CHANGE between the flights from the returns themselves (change_check): a stretch one flight calls roof where the
     other flight has ground returns (class 2: a pulse cannot reach the ground through a roof), or a median roof
     height difference over the shared roof above MAX_ROOF_DZ_M;
  3. registers, per fusion flight F, the truth T to use when a method read F: the best accepted other flight (choose.py's
     order), never the same project as F, never a pair with a change, never a pair whose outlines disagree
     (IoU < XF_MIN_IOU with no change found: one of the two is wrong and we cannot tell which).

Writes lidar/<slug>/crossflight.json and lidar/crossflight.json (summary + independence statistics) and prints a
table. Inputs: lidar/<slug>/units/*/{truth.json,points.npz,fetch.json}, the house's dsm.tif (frame only), eagleview.json
where present (reported, and rule A6). Deterministic: no randomness; sorted iteration; identical inputs give
identical output.

Usage: /Users/parsasalahshori-a/RooflineWork/venv/bin/python -I scripts/roof-bench-lidar/crossflight.py [slug ...]
"""
import glob, json, math, os, sys
import numpy as np
from pyproj import Transformer
from scipy import ndimage
from shapely.geometry import Polygon
from shapely.ops import unary_union

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from validate import grade, ev_compare, iou, boundary, utm_of, FALLBACK  # noqa: E402

R = os.environ.get('ROOF_BENCH_DIR', '/Users/parsasalahshori-a/RooflineWork/roof-bench')
L = f'{R}/lidar'
VERSION = 1

# ---- constants (physical scales; sensitivity +-20 % in docs/roof-3d/truth-crossflight.md)
GRID_M = 0.5                 # change grid: 2-4 QL2 returns per cell, 4-16 QL1; finer cells would be mostly empty at QL2
MIN_CHANGE_M2 = 4.0          # smallest roof change that counts: a 2 m x 2 m porch roof (lidar_truth keeps faces >= 1 m2,
                             # but a 1 m2 blob of ground returns is within the closing radius of an eave)
MAX_ROOF_DZ_M = 0.5          # validate.py's A4 line: a re-roof moves the surface centimetres, a rebuild or a new storey metres
GROUND_SHARE = 0.5           # a piece is open ground for a flight when half its returning cells hold a ground return:
                             # a roof under bare branches gives none, open ground under bare branches most
MIN_OBSERVED_M2 = 1.0        # ... and that flight returned something from at least this much of the piece
XF_MIN_IOU = 0.85            # two accepted truths of one unchanged roof must agree like truth and EagleView (validate EV_MIN_IOU)
COARSE_MAX_EDGE_ERROR_M = 0.50   # QL2's 2 roof returns per m2 give 0.48 m: area and IoU only, never the hidden-edge test
GROUND_CLASS = 2
NOISE = (7, 18)


def order_key(u):
    """choose.py's order: accepted first, fewer reasons, densest roof sampling, newest flight; then the name (stable)."""
    return (u['tier'] is None, len(u['reasons']), -u['density'], tuple(-ord(ch) for ch in u['end']), u['unit'])


def tier_of(reasons, expected_edge_error):
    if not reasons:
        return 'fine'
    if reasons == ['A2-density'] and expected_edge_error <= COARSE_MAX_EDGE_ERROR_M:
        return 'coarse'
    return None


def poly_xy(tr, t):
    ps = []
    for p in t['outline']:
        o = np.column_stack(tr.transform(*np.asarray(p['outer'], float).T))
        hs = [np.column_stack(tr.transform(*np.asarray(h, float).T)) for h in p['holes']]
        ps.append(Polygon(o, hs).buffer(0))
    return unary_union(ps)


def rasterize(poly, x0, y0, n, cell):
    """Cells whose centre lies inside the polygon (shapely-free: matplotlib-like even-odd on each ring)."""
    from shapely import contains_xy
    cx = x0 + (np.arange(n) + 0.5) * cell
    gx, gy = np.meshgrid(cx, y0 + (np.arange(n) + 0.5) * cell)
    return contains_xy(poly, gx.ravel(), gy.ravel()).reshape(n, n)


def cell_grids(pts, x0, y0, n, cell):
    """Per cell: any ground (class 2) return; the highest non-ground return (NaN where none)."""
    x, y, z, cls = pts
    ix = np.floor((x - x0) / cell).astype(int)
    iy = np.floor((y - y0) / cell).astype(int)
    ok = (ix >= 0) & (ix < n) & (iy >= 0) & (iy < n)
    ix, iy, z, cls = ix[ok], iy[ok], z[ok], cls[ok]
    ground = np.zeros((n, n), bool)
    g = cls == GROUND_CLASS
    ground[iy[g], ix[g]] = True
    top = np.full((n, n), -np.inf)
    np.maximum.at(top, (iy[~g], ix[~g]), z[~g])
    top[~np.isfinite(top)] = np.nan
    return ground, top


def change_check(poly_a, poly_b, pts_a, pts_b, err_a, err_b, cell=GRID_M):
    """Did the roof change between flight A and flight B?

    pts_* = (x, y, z, cls) in one metric frame (each flight's registration to Google's frame applied, z included).
    Only the interior of each difference region counts: it is eroded by the two outlines' expected edge errors
    (where the two outlines may honestly differ by sampling). Returns a dict with the largest contradicted blob each
    way (m2), the median roof height difference over the shared roof, and changed: bool.
    """
    u = poly_a.union(poly_b)
    if u.is_empty:
        return dict(changed=False, addedM2=0.0, removedM2=0.0, roofDzM=None, sharedCells=0)
    minx, miny, maxx, maxy = u.bounds
    pad = 2.0
    x0, y0 = math.floor(minx - pad), math.floor(miny - pad)
    n = int(math.ceil(max(maxx - x0, maxy - y0) + pad) / cell) + 1
    ma = rasterize(poly_a, x0, y0, n, cell)
    mb = rasterize(poly_b, x0, y0, n, cell)
    erode = max(1, int(round((err_a + err_b) / cell)))
    st = ndimage.generate_binary_structure(2, 1)
    only_b = ndimage.binary_erosion(mb & ~ma, st, iterations=erode)
    only_a = ndimage.binary_erosion(ma & ~mb, st, iterations=erode)
    both = ndimage.binary_erosion(ma & mb, st, iterations=erode)
    ga, ta = cell_grids(pts_a, x0, y0, n, cell)
    gb, tb = cell_grids(pts_b, x0, y0, n, cell)

    any_a = ga | np.isfinite(ta)
    any_b = gb | np.isfinite(tb)

    def contradicted(region, ground, seen):
        """The largest part of `region` (one connected piece, >= MIN_CHANGE_M2) where the other flight saw the ground:
        of its cells that have any return of that flight, at least GROUND_SHARE have a ground return. A roof stops
        every pulse; a crown over the ground lets some through; a crown over a roof gives no ground return at all.
        Judged per piece, not per cell, so a sparse flight (QL2: half the 0.5 m cells empty) is judged as fairly as a
        dense one."""
        lab, k = ndimage.label(region, st)
        best = 0.0
        for i in range(1, k + 1):
            piece = lab == i
            a = float(piece.sum()) * cell * cell
            if a < MIN_CHANGE_M2:
                continue
            obs = piece & seen
            if float(obs.sum()) * cell * cell < MIN_OBSERVED_M2:
                continue  # the other flight has (almost) no returns there: unobserved, not contradicted
            if (piece & ground).sum() / obs.sum() >= GROUND_SHARE:
                best = max(best, a)
        return best

    # roof in B where A saw the ground: built (or extended) after A; roof in A where B saw the ground: removed
    added = contradicted(only_b, ga, any_a)
    removed = contradicted(only_a, gb, any_b)
    shared = both & np.isfinite(ta) & np.isfinite(tb)
    dz = float(np.median(np.abs(ta[shared] - tb[shared]))) if shared.sum() >= 20 else None
    changed = added >= MIN_CHANGE_M2 or removed >= MIN_CHANGE_M2 or (dz is not None and dz > MAX_ROOF_DZ_M)
    return dict(changed=bool(changed), addedM2=round(added, 2), removedM2=round(removed, 2), roofDzM=None if dz is None else round(dz, 3), sharedCells=int(shared.sum()))


def load_points(unit_dir, t, epsg):
    """The unit's returns in the frame `epsg` with the truth's registration to Google's frame applied (x, y, z)."""
    meta = json.load(open(f'{unit_dir}/fetch.json'))
    P = np.load(f'{unit_dir}/points.npz')
    keep = ~np.isin(P['cls'], NOISE)
    # fetch.py already converted z to metres (points.npz is metres; zUnitsToM only records the source's unit)
    x, y, z, cls = P['x'][keep], P['y'][keep], P['z'][keep], P['cls'][keep]
    if meta['utmEpsg'] != epsg:
        x, y = Transformer.from_crs(meta['utmEpsg'], epsg, always_xy=True).transform(x, y)
    f = t['frame']
    # lidar_truth.py's frame: Google (x, y) = lidar (x, y) + (dxM, dyM); Google height + dzM = lidar height
    return (x + f['dxM'], y + f['dyM'], z - f['dzM'], cls)


def house(slug, h):
    """The cross-flight record of one house (None when it has fewer than two unit truths)."""
    dirs = sorted(d for d in glob.glob(f'{L}/{slug}/units/*') if os.path.exists(f'{d}/truth.json'))
    if len(dirs) < 2:
        return None
    hd = f'{R}/{h["dir"]}' if os.path.exists(f'{R}/{h["dir"]}/dsm.tif') else f'{FALLBACK}/{slug}'
    epsg = utm_of(*h['point'])
    tr = Transformer.from_crs(4326, epsg, always_xy=True)
    ev = json.load(open(f'{hd}/eagleview.json')) if os.path.exists(f'{hd}/eagleview.json') else None
    units = []
    for d in dirs:
        t = json.load(open(f'{d}/truth.json'))
        meta = json.load(open(f'{d}/fetch.json')) if os.path.exists(f'{d}/fetch.json') else {}
        name = os.path.basename(d)
        if not t.get('ok'):
            units.append(dict(unit=name, project=meta.get('project'), ql=meta.get('ql'), ok=False, tier=None, reasons=[f"truth-failed: {t.get('reason')}"],
                              density=0.0, end=max((x or '' for x in (meta.get('pointDates') or [''])), default=''), dir=d))
            continue
        evc = ev_compare(t, ev, tr) if ev is not None else None
        reasons = grade(t, evc)
        eee = t['method']['expectedEdgeErrorM']
        units.append(dict(unit=name, project=t['source']['project'], ql=t['source']['ql'], ok=True, tier=tier_of(reasons, eee), reasons=reasons,
                          density=t['checks']['roofPointsPerM2'], expectedEdgeErrorM=eee, planAreaM2=t['planAreaM2'], slopedAreaM2=t['slopedAreaM2'],
                          leafOff=t['source'].get('leafOffUnit'), end=max(x or '' for x in t['source']['pointDates']),
                          eagleview=None if evc is None else {k: evc[k] for k in ('iouAligned', 'boundaryM', 'planErrPct', 'slopedErrPct', 'structures')},
                          dir=d, _t=t))
    pairs = []
    ok_units = [u for u in units if u['ok']]
    for i in range(len(ok_units)):
        for j in range(i + 1, len(ok_units)):
            a, b = ok_units[i], ok_units[j]
            if a['end'] > b['end']:
                a, b = b, a  # A: the older flight
            pa, pb = poly_xy(tr, a['_t']), poly_xy(tr, b['_t'])
            bm, hd95, _ = boundary(pa, pb)
            ch = change_check(pa, pb, load_points(a['dir'], a['_t'], epsg), load_points(b['dir'], b['_t'], epsg), a['expectedEdgeErrorM'], b['expectedEdgeErrorM'])
            same = a['project'] == b['project']
            v = iou(pa, pb)
            refuse = 'same-project' if same else 'roof-changed' if ch['changed'] else None
            pairs.append(dict(older=a['unit'], newer=b['unit'], iou=round(v, 4), boundaryM=round(bm, 3), hd95M=round(hd95, 3),
                              planOlderM2=round(pa.area, 2), planNewerM2=round(pb.area, 2), planDiffPct=round(100 * (pb.area - pa.area) / max(pa.area, 1e-9), 2),
                              change=ch, refused=refuse))
    pair_of = {}
    for p in pairs:
        pair_of[(p['older'], p['newer'])] = pair_of[(p['newer'], p['older'])] = p
    registry = {}
    for f in units:  # every flight a method might read
        cands = []
        for t in units:
            if t['unit'] == f['unit']:
                continue
            p = pair_of.get((f['unit'], t['unit']))
            why = None
            if t['tier'] is None:
                why = 'truth-not-accepted: ' + ','.join(t['reasons'])
            elif f['project'] is not None and f['project'] == t['project']:
                why = 'same-project'
            elif p is None:
                why = 'fusion-flight-has-no-truth-to-compare'  # the fused flight's own truth failed: no change check possible
            elif p['refused']:
                why = p['refused']
            elif p['iou'] < XF_MIN_IOU and not (t['tier'] == 'fine' and t['planAreaM2'] >= f.get('planAreaM2', 0.0)):
                # Unchanged roof, outlines disagree: one flight missed roof (sparse returns under canopy) or took in
                # something that is not roof. A truth that is the SMALLER of the two may be the one that missed roof:
                # refuse it. The larger one, when it passes every rule (A3: its edges are observed; A4/A6), is kept:
                # the change check found no ground returns of the other flight under the extra roof.
                why = 'outlines-disagree'
            cands.append((why, t))
        good = sorted((t for why, t in cands if why is None), key=order_key)
        if good:
            t = good[0]
            p = pair_of[(f['unit'], t['unit'])]
            registry[f['unit']] = dict(truthUnit=t['unit'], truthProject=t['project'], tier=t['tier'], truthQl=t['ql'], expectedEdgeErrorM=t['expectedEdgeErrorM'],
                                       interFlightIoU=p['iou'], disagree=p['iou'] < XF_MIN_IOU, yearsApart=abs(int(t['end'][:4]) - int(f['end'][:4])) if t['end'] and f['end'] else None)
        else:
            registry[f['unit']] = dict(truthUnit=None, refused=sorted({why for why, _ in cands}) or ['no-other-flight'])
    clean = [{k: v for k, v in u.items() if k not in ('dir', '_t')} for u in units]
    return dict(version=VERSION, slug=slug, units=clean, pairs=pairs, registry=registry,
                rules=dict(GRID_M=GRID_M, MIN_CHANGE_M2=MIN_CHANGE_M2, MAX_ROOF_DZ_M=MAX_ROOF_DZ_M, XF_MIN_IOU=XF_MIN_IOU, COARSE_MAX_EDGE_ERROR_M=COARSE_MAX_EDGE_ERROR_M))


def independence(records, manifest):
    """How independent is a second flight? Agreement between flights (the truth method's own noise floor plus real
    differences), and on houses with EagleView whether the two flights' errors move together (shared method bias)."""
    canopy = {h['slug']: (h['tags'].get('canopy') or {}).get('class') for h in manifest['houses']}
    rows = []
    for r in records:
        for p in r['pairs']:
            if p['refused'] == 'same-project':
                continue
            u = {x['unit']: x for x in r['units']}
            a, b = u[p['older']], u[p['newer']]
            rows.append(dict(slug=r['slug'], canopy=canopy.get(r['slug']), iou=p['iou'], changed=p['change']['changed'], planDiffPct=p['planDiffPct'],
                             evA=(a.get('eagleview') or {}).get('planErrPct'), evB=(b.get('eagleview') or {}).get('planErrPct'),
                             evIouA=(a.get('eagleview') or {}).get('iouAligned'), evIouB=(b.get('eagleview') or {}).get('iouAligned'),
                             years=abs(int(b['end'][:4]) - int(a['end'][:4])) if a['end'] and b['end'] else None,
                             qls=f"{a['ql']}/{b['ql']}", tiers=f"{a['tier']}/{b['tier']}"))
    out = {}
    for cls in ('none', 'light', 'heavy', None):
        s = [x for x in rows if (cls is None or x['canopy'] == cls) and not x['changed']]
        if s:
            ious = sorted(x['iou'] for x in s)
            out['all' if cls is None else cls] = dict(pairs=len(s), medianIoU=round(float(np.median(ious)), 4), minIoU=ious[0],
                                                      medianAbsPlanDiffPct=round(float(np.median([abs(x['planDiffPct']) for x in s])), 2))
    ev = [x for x in rows if x['evA'] is not None and x['evB'] is not None and not x['changed']]
    if len(ev) >= 3:
        ea, eb = np.array([x['evA'] for x in ev]), np.array([x['evB'] for x in ev])
        out['eagleview'] = dict(pairs=len(ev), corrPlanErr=None if ea.std() == 0 or eb.std() == 0 else round(float(np.corrcoef(ea, eb)[0, 1]), 3),
                                meanPlanErrOlder=round(float(ea.mean()), 2), meanPlanErrNewer=round(float(eb.mean()), 2),
                                meanAbsPlanErrOlder=round(float(np.abs(ea).mean()), 2), meanAbsPlanErrNewer=round(float(np.abs(eb).mean()), 2))
    # The registered truths themselves (what a fusion run is scored on) against EagleView, by tier.
    for tier in ('fine', 'coarse'):
        evs = []
        for r in records:
            u = {x['unit']: x for x in r['units']}
            for f, e in sorted(r['registry'].items()):
                if e.get('truthUnit') and e['tier'] == tier and (u[e['truthUnit']].get('eagleview') or {}).get('iouAligned') is not None:
                    ev_ = u[e['truthUnit']]['eagleview']
                    evs.append(dict(slug=r['slug'], fused=f, truth=e['truthUnit'], iouAligned=ev_['iouAligned'], planErrPct=ev_['planErrPct'], boundaryM=ev_['boundaryM']))
        if evs:
            out[f'registered_{tier}_vs_eagleview'] = dict(n=len(evs), medianIoUAligned=round(float(np.median([x['iouAligned'] for x in evs])), 4),
                                                         meanPlanErrPct=round(float(np.mean([x['planErrPct'] for x in evs])), 2),
                                                         medianBoundaryM=round(float(np.median([x['boundaryM'] for x in evs])), 3), rows=evs)
    out['rows'] = rows
    return out


def main(slugs):
    m = json.load(open(f'{R}/manifest.json'))
    records = []
    for h in sorted(m['houses'], key=lambda h: h['slug']):
        if slugs and h['slug'] not in slugs:
            continue
        r = house(h['slug'], h)
        if r is None:
            continue
        r['split'] = h['split']
        json.dump(r, open(f'{L}/{h["slug"]}/crossflight.json', 'w'), indent=1, sort_keys=True)
        records.append(r)
        reg = ' '.join(f"{f}->{v['truthUnit']}({v['tier']})" if v['truthUnit'] else f"{f}->x[{';'.join(v['refused'])}]" for f, v in sorted(r['registry'].items()))
        pr = ' '.join(f"iou={p['iou']} d={p['planDiffPct']}% +{p['change']['addedM2']}/-{p['change']['removedM2']}m2 dz={p['change']['roofDzM']} {p['refused'] or 'ok'}" for p in r['pairs'])
        print(f"{h['slug']:34} {h['split']:7} {pr} | {reg}", flush=True)
    if not slugs:
        summ = dict(version=VERSION, credit='USGS 3D Elevation Program (3DEP) lidar, public domain',
                    houses={r['slug']: dict(split=r['split'], registry=r['registry']) for r in records},
                    independence=independence(records, m))
        json.dump(summ, open(f'{L}/crossflight.json', 'w'), indent=1, sort_keys=True)
        ind = summ['independence']
        print(json.dumps({k: v for k, v in ind.items() if k != 'rows'}, indent=1))


if __name__ == '__main__':
    main(sys.argv[1:])
