"""Validate the lidar roof truth before anyone scores against it, and grade it.

For every house with lidar/<slug>/truth.json:
  * against EagleView (where the house has eagleview.json): outline IoU raw and after the best translation within
    +-3 m (EagleView's frame is offset from Google's; the same rule as the benchmark's aligned metric), symmetric mean
    boundary distance (0.2 m samples) after that translation, plan and sloped area, main pitch and per-face pitch
    (each EagleView face >= 100 sq ft against the lidar plane covering most of it, area weighted);
  * acceptance (truth grade 'lidar') from the truth's own checks, none of which uses the product's reconstruction:
      A1 frame registration found: robust height residual (MAD) <= REG_MAD_M, the shift not at the search limit, and
         well conditioned (half a metre off the best shift along either axis fits worse);
      A2 the truth's expected edge error (half the roof's point spacing plus half the 0.25 m cell) <= MAX_EDGE_ERROR_M
         (8 roof returns per m2: QL2's 2 per m2 gives 0.48 m, as coarse as the error it would judge);
      A3 edges observed: lidar has a ground-level return just outside >= MIN_EDGE_OBSERVED of the outline samples
         (a roof edge under leaf-on canopy is not observed, so leaf-on lidar is rejected under trees by measurement,
         not by calendar);
      A4 no change between the captures: Google's heights at the ground over <= MAX_CHANGE of the lidar roof, lidar
         ground under <= MAX_CHANGE of Google's roof-high cells in Google's building box, median roof height
         difference <= MAX_ROOF_DZ_M;
      A5 sanity: 40 m2 <= plan area, footprint / Google box area within FOOTPRINT_BOX;
      A6 where an EagleView report of one structure exists: aligned outline IoU >= EV_MIN_IOU (the outline is what the
         grade is for; the pitch comparison is reported, not required: a complex roof's dominant pitch is ambiguous).
    Leaf-off (every lidar point dated Nov..Apr) is recorded, not required (A3 measures what it is for).

Writes lidar/index.json and prints the validation table. Deterministic.
"""
import json, math, os, sys
import numpy as np
from pyproj import Transformer
from shapely.geometry import Polygon, MultiPolygon, shape
from shapely.affinity import translate
from shapely.ops import unary_union

R = os.environ.get('ROOF_BENCH_DIR', '/Users/parsasalahshori-a/RooflineWork/roof-bench')
L = f'{R}/lidar'
FALLBACK = '/Users/parsasalahshori-a/RooflineWork/saved-testdata'

REG_MAD_M = 0.20
MAX_EDGE_ERROR_M = 0.30   # the truth's own expected edge error (half the roof point spacing + half a cell) must be well
                          # under the 0.5 m the hidden-edge metric judges at: 0.30 m is 8 roof returns per m2
MIN_EDGE_OBSERVED = 0.85
MAX_CHANGE = 0.10
MAX_ROOF_DZ_M = 0.5
MIN_PLAN_M2 = 40.0
FOOTPRINT_BOX = (0.4, 2.5)
EV_MIN_IOU = 0.85
LEAF_OFF = {11, 12, 1, 2, 3, 4}
SQFT = 10.7639104167


def utm_of(lng, lat):
    return (32600 if lat >= 0 else 32700) + int((lng + 180) // 6) + 1


def to_xy(tr, ring):
    a = np.asarray(ring, float)
    x, y = tr.transform(a[:, 0], a[:, 1])
    return np.column_stack([x, y])


def lidar_poly(tr, t):
    ps = [Polygon(to_xy(tr, p['outer']), [to_xy(tr, h) for h in p['holes']]) for p in t['outline']]
    return unary_union([p.buffer(0) for p in ps])


def ev_poly(tr, g):
    gg = shape(g)
    polys = gg.geoms if isinstance(gg, MultiPolygon) else [gg]
    return unary_union([Polygon(to_xy(tr, np.asarray(p.exterior.coords)), [to_xy(tr, np.asarray(h.coords)) for h in p.interiors]).buffer(0) for p in polys])


def iou(a, b):
    u = a.union(b).area
    return a.intersection(b).area / u if u > 0 else 0.0


def samples(poly, step=0.2):
    out = []
    geoms = poly.geoms if isinstance(poly, MultiPolygon) else [poly]
    for g in geoms:
        for ring in [g.exterior, *g.interiors]:
            n = max(1, int(ring.length / step))
            out += [ring.interpolate(i * ring.length / n) for i in range(n)]
    return out


def boundary(a, b, step=0.2):
    da = [b.boundary.distance(p) for p in samples(a, step)]
    db = [a.boundary.distance(p) for p in samples(b, step)]
    allv = da + db
    return float(np.mean(allv)), float(max(np.percentile(da, 95), np.percentile(db, 95))), da


def best_shift(a, b, maxs=3.0):
    best = (iou(a, b), 0.0, 0.0)
    for dx in np.arange(-maxs, maxs + 1e-9, 0.25):
        for dy in np.arange(-maxs, maxs + 1e-9, 0.25):
            v = iou(a, translate(b, dx, dy))
            if v > best[0] + 1e-12:
                best = (v, dx, dy)
    b0 = best
    for dx in np.arange(-0.2, 0.2 + 1e-9, 0.05):
        for dy in np.arange(-0.2, 0.2 + 1e-9, 0.05):
            v = iou(a, translate(b, b0[1] + dx, b0[2] + dy))
            if v > best[0] + 1e-12:
                best = (v, b0[1] + dx, b0[2] + dy)
    return best


def dominant(items):
    acc = {}
    for p, a in items:
        k = int(round(p))  # nearest whole x/12, half to even like the benchmark
        acc[k] = acc.get(k, 0) + a
    return max(acc, key=lambda k: (acc[k], -k)) if acc else None


def ev_compare(t, ev, tr):
    lp = lidar_poly(tr, t)
    ep = ev_poly(tr, ev['outline'])
    raw = iou(lp, ep)
    a_iou, dx, dy = best_shift(lp, ep)
    eps = translate(ep, dx, dy)
    bmean, hd95, _ = boundary(lp, eps)
    ev_plan = sum((f.get('plan_sqft') or 0) for f in ev['faces']) / SQFT
    area_err = 100 * (t['slopedAreaM2'] * SQFT - ev['total_sloped_sqft']) / ev['total_sloped_sqft']
    plan_err = 100 * (lp.area - ep.area) / ep.area if ep.area > 0 else None
    ev_main = dominant([(f['pitch_x12'] or 0, f['sloped_sqft'] or 0) for f in ev['faces']])
    # per-face pitch: each EV face >= 100 sq ft against the lidar plane covering most of it (after the shift)
    planes = []
    for pl in t['planes']:
        rings = [Polygon(to_xy(tr, r)).buffer(0) for r in pl['rings'] if len(r) >= 4]
        if rings:
            planes.append((pl, unary_union(rings)))
    werr = wsum = within = unmatched = alla = 0.0
    for f in ev['faces']:
        a = f['sloped_sqft'] or 0
        if a < 100:
            continue
        alla += a
        fp = translate(Polygon(to_xy(tr, f['ring'])).buffer(0), dx, dy)
        best, ov = None, 0.0
        for pl, g in planes:
            o = g.intersection(fp).area
            if o > ov:
                best, ov = pl, o
        if best is None or ov < 0.3 * fp.area:
            unmatched += a
            continue
        e = abs(best['pitchX12'] - (f['pitch_x12'] or 0))
        werr += e * a; wsum += a; within += a if e <= 1.0 else 0
    return dict(iouRaw=round(raw, 4), iouAligned=round(a_iou, 4), shiftM=[round(dx, 2), round(dy, 2)], boundaryM=round(bmean, 3), hd95M=round(hd95, 3),
                planErrPct=None if plan_err is None else round(plan_err, 2), slopedErrPct=round(area_err, 2), evPlanM2=round(ep.area, 1), lidarPlanM2=round(lp.area, 1),
                mainPitchLidar=t['mainPitchX12'], mainPitchEV=ev_main, mainPitchErr=None if t['mainPitchX12'] is None or ev_main is None else abs(t['mainPitchX12'] - ev_main),
                facePitchMAE=round(werr / wsum, 3) if wsum else None, faceWithin1Pct=round(100 * within / wsum, 1) if wsum else None,
                faceUnmatchedPct=round(100 * unmatched / alla, 1) if alla else None, structures=ev['structures'])


def leaf_off(dates):
    if not dates or any(d is None for d in dates):
        return None
    return all(int(d[5:7]) in LEAF_OFF for d in dates)


def grade(t, evc):
    c, f = t['checks'], t['frame']
    reasons = []
    if not (f['madM'] <= REG_MAD_M and not f['atLimit'] and f.get('conditioned', True)):
        reasons.append('A1-frame')
    if 0.5 / math.sqrt(max(c['roofPointsPerM2'], 0.1)) + 0.125 > MAX_EDGE_ERROR_M:
        reasons.append('A2-density')
    if c['edgeObservedShare'] < MIN_EDGE_OBSERVED:
        reasons.append('A3-edges-unobserved')
    g1, g2, dzm = c['googleGroundInLidarRoof'], c['googleRoofWhereLidarGround'], c['roofHeightMadM']
    if (g1 is not None and g1 > MAX_CHANGE) or (g2 is not None and g2 > MAX_CHANGE) or (dzm is not None and dzm > MAX_ROOF_DZ_M):
        reasons.append('A4-changed')
    if t['planAreaM2'] < MIN_PLAN_M2 or not (FOOTPRINT_BOX[0] <= c['footprintOverBox'] <= FOOTPRINT_BOX[1]):
        reasons.append('A5-sanity')
    if evc is not None and evc['structures'] == 1:
        if evc['iouAligned'] < EV_MIN_IOU:
            reasons.append('A6-eagleview')
    return reasons


def main():
    m = json.load(open(f'{R}/manifest.json'))
    cov = json.load(open(f'{L}/coverage.json'))
    index = {'version': 1, 'rules': dict(REG_MAD_M=REG_MAD_M, MAX_EDGE_ERROR_M=MAX_EDGE_ERROR_M, MIN_EDGE_OBSERVED=MIN_EDGE_OBSERVED, MAX_CHANGE=MAX_CHANGE,
                                         MAX_ROOF_DZ_M=MAX_ROOF_DZ_M, MIN_PLAN_M2=MIN_PLAN_M2, FOOTPRINT_BOX=FOOTPRINT_BOX, EV_MIN_IOU=EV_MIN_IOU),
             'credit': 'USGS 3D Elevation Program (3DEP) lidar, public domain', 'houses': {}}
    for h in m['houses']:
        slug = h['slug']
        canopy = (h['tags']['canopy'] or {}).get('class')
        tp = f'{L}/{slug}/truth.json'
        entry = dict(set=h['set'], split=h['split'], canopy=canopy, truth=h['truth'])
        if not os.path.exists(tp):
            entry.update(grade='none', reasons=['no-lidar' if cov.get(slug, {}).get('pick') is None else 'not-fetched'])
            index['houses'][slug] = entry
            continue
        t = json.load(open(tp))
        if not t.get('ok'):
            entry.update(grade='rejected', reasons=[f"truth-failed: {t.get('reason')}"])
            index['houses'][slug] = entry
            continue
        tr = Transformer.from_crs(4326, utm_of(*h['point']), always_xy=True)
        evc = None
        d = f'{R}/{h["dir"]}' if os.path.exists(f'{R}/{h["dir"]}/dsm.tif') else f'{FALLBACK}/{slug}'
        if os.path.exists(f'{d}/eagleview.json'):
            evc = ev_compare(t, json.load(open(f'{d}/eagleview.json')), tr)
        reasons = grade(t, evc)
        entry.update(grade='lidar' if not reasons else 'rejected', reasons=reasons, leafOff=leaf_off(t['source']['pointDates']),
                     project=t['source']['project'], ql=t['source']['ql'], pointDates=t['source']['pointDates'], checks=t['checks'], frame=t['frame'],
                     planAreaM2=t['planAreaM2'], slopedAreaM2=t['slopedAreaM2'], mainPitchX12=t['mainPitchX12'], eagleview=evc,
                     expectedEdgeErrorM=t['method']['expectedEdgeErrorM'])
        index['houses'][slug] = entry
    json.dump(index, open(f'{L}/index.json', 'w'), indent=1, sort_keys=True)
    H = index['houses']
    print(f"{'slug':34} {'split':7} {'canopy':6} {'grade':8} {'leafoff':7} {'dens':>5} {'edge':>5} {'mad':>5} {'evIoUa':>6} {'evBd':>5} {'evArea%':>7} {'pitch':>5} reasons")
    only = sys.argv[1] if len(sys.argv) > 1 else None   # 'dev' while tuning: held-out houses are for the final check
    for s, e in H.items():
        if only is not None and e['split'] != only:
            continue
        ev = e.get('eagleview') or {}
        c = e.get('checks') or {}
        print(f"{s:34} {e['split']:7} {str(e['canopy']):6} {e['grade']:8} {str(e.get('leafOff')):7} {c.get('roofPointsPerM2', ''):>5} {c.get('edgeObservedShare', ''):>5} "
              f"{(e.get('frame') or {}).get('madM', ''):>5} {ev.get('iouAligned', ''):>6} {ev.get('boundaryM', ''):>5} {ev.get('slopedErrPct', ''):>7} {str(ev.get('mainPitchErr', '')):>5} {','.join(e['reasons'])}")


if __name__ == '__main__':
    main()
