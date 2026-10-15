"""Shared geometry: lng/lat rings to metres (the house's UTM zone) and the comparison's outline metrics.

The aligned metrics follow the harness's EagleView rule (truth.ts alignedOutline): the key is moved by the translation
within ALIGN_MAX_SHIFT_M that overlaps the estimate best (a 0.1 m grid search, then the best cell refined to 0.05 m)
before IoU and boundary distance; plan-area error is frame-independent.
"""
import math
from pyproj import Transformer
from shapely.geometry import Polygon, MultiPolygon, Point
from shapely.ops import unary_union
from shapely import affinity

ALIGN_MAX_SHIFT_M = 3.0


def utm_for(lng, lat):
    zone = int((lng + 180) // 6) + 1
    epsg = (32600 if lat >= 0 else 32700) + zone
    return Transformer.from_crs(4326, epsg, always_xy=True)


def to_xy(tr, rings):
    """A polygon (outer ring first, then holes) or list of outer rings -> shapely geometry in metres."""
    polys = []
    for r in rings:
        xs, ys = tr.transform([p[0] for p in r], [p[1] for p in r])
        p = Polygon(list(zip(xs, ys)))
        if not p.is_valid: p = p.buffer(0)
        if not p.is_empty: polys.append(p)
    return unary_union(polys) if polys else None


def iou(a, b):
    u = a.union(b).area
    return a.intersection(b).area / u if u > 0 else 0.0


def boundary_mean(a, b, step=0.2):
    """Symmetric mean distance between two outlines' boundaries, sampled every `step` metres."""
    def samples(g):
        out = []
        for line in ([g.boundary] if g.boundary.geom_type == "LineString" else list(g.boundary.geoms)):
            n = max(int(line.length / step), 1)
            out += [line.interpolate(i * step) for i in range(n)]
        return out
    sa, sb = samples(a), samples(b)
    da = [b.boundary.distance(p) for p in sa]
    db = [a.boundary.distance(p) for p in sb]
    d = da + db
    return sum(d) / len(d) if d else None


def best_shift(est, key, maxm=ALIGN_MAX_SHIFT_M):
    best = (iou(est, key), 0.0, 0.0)
    step = 0.25
    k = int(maxm / step)
    for i in range(-k, k + 1):
        for j in range(-k, k + 1):
            dx, dy = i * step, j * step
            if math.hypot(dx, dy) > maxm: continue
            v = iou(est, affinity.translate(key, dx, dy))
            if v > best[0] + 1e-12: best = (v, dx, dy)
    _, bx, by = best
    for i in range(-5, 6):
        for j in range(-5, 6):
            dx, dy = bx + i * 0.05, by + j * 0.05
            if math.hypot(dx, dy) > maxm: continue
            v = iou(est, affinity.translate(key, dx, dy))
            if v > best[0] + 1e-12: best = (v, dx, dy)
    return best


def compare(est, key):
    """Outline metrics of an estimate against a key (both shapely, metres)."""
    raw = iou(est, key)
    a, dx, dy = best_shift(est, key)
    moved = affinity.translate(key, dx, dy)
    return {"iou": round(raw, 4), "alignedIoU": round(a, 4), "shiftM": [round(dx, 2), round(dy, 2)],
            "alignedBoundaryM": round(boundary_mean(est, moved), 3),
            "planErrPct": round(100 * (est.area - key.area) / key.area, 2) if key.area > 0 else None}
