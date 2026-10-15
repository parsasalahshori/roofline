"""Roof outline truth from USGS 3DEP lidar, independent of the product's reconstruction.

Nothing here imports or ports the product's roof-reconstruct code. Inputs per house: lidar/<slug>/points.npz (fetch.py,
WGS84 UTM metres) and, only for the frame registration and the change check, Google's dsm.tif and bi.json (building
box: which building is the house). The outline shape comes from lidar points alone.

Method (docs/roof-3d/truth.md has the reasoning and the expected error):
  1. Ground: class 2 points -> 1 m grid of medians, holes filled by linear then nearest interpolation (a simple
     lowest-point filter when a project has too few class 2 points). Height above ground (HAG) per point.
  2. Candidates: HAG >= MIN_HAG_M, not ground/noise/water.
  3. Vegetation rejection: local PCA over the neighbours within the normal radius; a point is planar when the rms
     distance of its neighbours to their best plane is <= PLANAR_RMS_M. Branches and crowns are rough or linear;
     roofs are planes. Returns that are first-of-many are not rejected outright (an eave splits pulses too), the
     planarity test decides.
  4. Planar segmentation: region growing from the flattest points: a neighbour joins when its normal is within
     GROW_ANGLE_DEG of the region's plane normal and it lies within GROW_DIST_M of the plane (refit as it grows).
     Regions under MIN_PLANE_M2 of roof, steeper than MAX_SLOPE_DEG (walls) or rougher than PLANE_RMS_M are dropped.
  5. The house: the plane nearest the house point (inside Google's building box) and every plane connected to it
     (a shared edge: LINK_MIN_POINTS points within LINK_M in plan, at most MAX_STEP_M apart in height; only faces of
     BIG_PLANE_M2 or more carry the link on). Google's box picks the building; it does not limit the outline.
  6. Outline: house points rasterised at CELL_M, closed with a disk of the point spacing (bridges the gaps between
     points), holes filled, then grown by half the point spacing (the true edge lies on average half a spacing
     beyond the outermost roof point), necks narrower than 2 x NECK_M cut, traced and simplified by SIMPLIFY_M.
  7. Planes: pitch and azimuth from each plane's fitted normal; each outline cell goes to its nearest plane point,
     giving plan and sloped area per plane.
  8. Frame: the lidar is shifted onto Google's frame by the translation (within +-MAX_SHIFT_M) that best fits the
     lidar roof points to Google's height map (rigid; a robust spread of height residuals is minimised). The outline
     shape is untouched; the shift is recorded.
  9. Self-checks recorded for acceptance (validate.py): roof point density, edge observation (lidar sees a return
     EDGE_DROP_M below the roof edge just outside each outline sample), changes between the captures (Google sees
     ground where lidar has roof, or roof where lidar sees ground).

Usage: python -I lidar_truth.py [slug ...]     for every fetched work unit: lidar/<slug>/units/<unit>/truth.json
       and truth.png (choose.py then picks one per house)
Deterministic: no randomness; identical inputs give identical output.
"""
import json, math, os, sys
import numpy as np
import tifffile
from scipy import ndimage
from scipy.interpolate import griddata
from scipy.spatial import cKDTree
from pyproj import Transformer
from skimage import measure
from shapely.geometry import MultiPoint, Polygon, MultiPolygon, Point, box as sbox
from shapely.ops import unary_union

R = os.environ.get('ROOF_BENCH_DIR', '/Users/parsasalahshori-a/RooflineWork/roof-bench')
L = f'{R}/lidar'
FALLBACK = '/Users/parsasalahshori-a/RooflineWork/saved-testdata'

# ---- constants (every one is a physical scale, not a fitted value; sensitivity in docs/roof-3d/truth.md)
MIN_HAG_M = 1.5          # lowest roof considered: a shed or porch roof is 2 m or more above the ground
GROUND_CELL_M = 1.0      # ground grid
PLANAR_RMS_M = 0.10      # lidar noise 2-5 cm, plus up to ~5 cm between overlapping flight lines (QL2 allows 6-8 cm); a crown is 0.3 m+
NORMAL_R_MIN_M = 0.8     # normal radius: at least this, and at least 2.5 x the point spacing
GROW_ANGLE_DEG = 12.0    # two faces of a hip roof differ by 30 degrees or more; 12 keeps noise in, faces apart
GROW_DIST_M = 0.20       # a point this far off the region's plane belongs elsewhere (2 x the planar noise)
PLANE_RMS_M = 0.12       # a plane rougher than this overall is not a roof face
MIN_PLANE_M2 = 1.0       # smallest face kept (EagleView draws faces of a few sq ft; 1 m2 = 10.8 sq ft)
MAX_SLOPE_DEG = 65.0     # steeper than ~25/12 is a wall or a tree trunk, not a roof
LINK_M = 1.2             # planes of one roof touch: their points come within max(this, 2 x spacing) in plan (houses stand 3 m+ apart)
CELL_M = 0.25            # outline raster (the brief's 0.25 m)
SIMPLIFY_M = 0.10        # Douglas-Peucker tolerance on the traced outline
REG_PROBE_M = 0.5        # the frame fit is probed half a metre off its best along each axis
REG_MIN_RISE_M = 0.01    # ... and must worsen the residual spread by 1 cm at least (the noise of the MAD itself is mm)
MAX_SHIFT_M = 3.0        # frame registration search, metres each axis (NAD83(2011) vs WGS84 is ~1-1.5 m in CONUS)
EDGE_STEP_M = 0.2        # outline sampling for the edge observation check
EDGE_OUT_M = (0.3, 1.5)  # a sample is observed when lidar has a ground-level return this far outside it
LOW_HAG_M = 1.0          # ground-level: HAG under this
EDGE_DROP_M = 1.0        # seen past the eave: a return this far below the roof edge (the bench's strong eave drop)
ATTACH_DIST_M = 0.25     # a ridge or eave point lies on its plane's extension within this (5 x the noise)
ATTACH_ROUNDS = 3        # attachment rounds (each reaches one attach radius further)
NECK_M = 1.0              # a joint narrower than 2 m between two roofed parts is not one roof (a breezeway roof is 2.5 m+)
MAX_STEP_M = 3.5          # a roof steps down to a lower roof by one storey at most where the two touch in plan
LINK_MIN_POINTS = 8       # two faces of one roof share an edge: at least this many points within the link distance
LINK_MIN_LEN_M = 1.0      # ... spread over at least this length
BIG_PLANE_M2 = 4.0        # a face that can join two parts of a roof: 4 m2 (43 sq ft), well over a vent or a branch patch
SEED_MIN_M2 = 3.0        # the house's first plane is a real roof face, not an AC unit or a car
MIN_CLOSE_M = 0.75       # closing radius floor: scan lines of a 2 pts/m2 project are up to ~1 m apart


def house_dir(slug, set_):
    for base in (R, FALLBACK):
        d = f'{base}/{set_}/{slug}' if base == R else f'{base}/{slug}'
        if os.path.exists(f'{d}/dsm.tif'):
            return d
    return None


def read_geotiff(path):
    t = tifffile.TiffFile(path)
    p = t.pages[0]
    a = p.asarray()
    tags = p.tags
    if 'ModelTransformationTag' in tags:
        m = tags['ModelTransformationTag'].value
        sx, ox, sy, oy = m[0], m[3], -m[5], m[7]
    else:
        tp = tags['ModelTiepointTag'].value
        sc = tags['ModelPixelScaleTag'].value
        sx, sy = sc[0], sc[1]
        ox, oy = tp[3] - tp[0] * sx, tp[4] + tp[1] * sy
    geo = tags['GeoKeyDirectoryTag'].value
    epsg = None
    for k in range(4, len(geo), 4):
        if geo[k] == 3072:
            epsg = geo[k + 3]
    return a, dict(ox=ox, oy=oy, sx=sx, sy=sy, epsg=epsg)


def pca_normals(xyz, tree, r, min_n=6):
    """Per point: unit normal (z >= 0), rms distance of the neighbourhood to its plane, neighbour count."""
    n = len(xyz)
    normals = np.zeros((n, 3))
    rms = np.full(n, np.inf)
    counts = np.zeros(n, int)
    nb = tree.query_ball_point(xyz, r)  # a sphere: a branch a metre above the roof is not the roof's neighbour
    for i, idx in enumerate(nb):
        counts[i] = len(idx)
        if len(idx) < min_n:
            continue
        q = xyz[idx]
        c = q - q.mean(0)
        w, v = np.linalg.eigh(c.T @ c / len(idx))
        nrm = v[:, 0]
        if nrm[2] < 0:
            nrm = -nrm
        normals[i] = nrm
        rms[i] = math.sqrt(max(w[0], 0.0))
    return normals, rms, counts


def fit_plane(q):
    c = q.mean(0)
    w, v = np.linalg.eigh(np.cov((q - c).T))
    nrm = v[:, 0]
    if nrm[2] < 0:
        nrm = -nrm
    d = (q - c) @ nrm
    return c, nrm, float(np.sqrt(np.mean(d * d)))


def region_grow(xyz, normals, rms, planar, tree2, r_grow):
    """Labels (-1 = none). Seeds in order of flatness (then index: deterministic)."""
    n = len(xyz)
    label = np.full(n, -1, int)
    order = np.lexsort((np.arange(n), rms))
    cos_t = math.cos(math.radians(GROW_ANGLE_DEG))
    nb_cache = tree2.query_ball_point(xyz, r_grow)
    nl = 0
    for s in order:
        if not planar[s] or label[s] != -1:
            continue
        members = [s]
        label[s] = nl
        c, nrm = xyz[s].copy(), normals[s].copy()
        front = [s]
        refit_at = 8
        while front:
            nxt = []
            for p in front:
                for q in nb_cache[p]:
                    if label[q] != -1 or not planar[q]:
                        continue
                    if abs(normals[q] @ nrm) < cos_t:
                        continue
                    if abs((xyz[q] - c) @ nrm) > GROW_DIST_M:
                        continue
                    label[q] = nl
                    members.append(q)
                    nxt.append(q)
            front = nxt
            if len(members) >= refit_at:
                c, nrm, _ = fit_plane(xyz[members])
                refit_at = int(len(members) * 1.5) + 1
        nl += 1
    return label, nl


def run(slug, set_, point, d, write_png=True, out_path=None):
    meta = json.load(open(f'{d}/fetch.json'))
    P = np.load(f'{d}/points.npz')
    x, y, z = P['x'], P['y'], P['z']
    cls, rn, nr = P['cls'], P['rn'], P['nr']
    keep = ~np.isin(cls, (7, 18))  # noise
    x, y, z, cls, rn, nr = x[keep], y[keep], z[keep], cls[keep], rn[keep], nr[keep]
    utm = meta['utmEpsg']
    hd = house_dir(slug, set_)
    dsm, gtf = read_geotiff(f'{hd}/dsm.tif')
    if gtf['epsg'] != utm:  # Google's grid is in a neighbouring zone: work in Google's
        x, y = Transformer.from_crs(utm, gtf['epsg'], always_xy=True).transform(x, y)
        utm = gtf['epsg']
    to_utm = Transformer.from_crs(4326, utm, always_xy=True)
    to_ll = Transformer.from_crs(utm, 4326, always_xy=True)
    px, py = to_utm.transform(*point)
    x0, y0 = px - meta['halfM'], py - meta['halfM']
    W = int(round(2 * meta['halfM'] / CELL_M))

    # point spacing from last/only returns (one per pulse) over the crop
    last = rn == nr
    area_crop = (2 * meta['halfM']) ** 2
    pulse_density = last.sum() / area_crop
    spacing = 1 / math.sqrt(max(pulse_density, 0.1))

    # ---- 1 ground
    g = cls == 2
    G = int(round(2 * meta['halfM'] / GROUND_CELL_M))
    gx = np.clip(((x - x0) / GROUND_CELL_M).astype(int), 0, G - 1)
    gy = np.clip(((y - y0) / GROUND_CELL_M).astype(int), 0, G - 1)
    ground_method = 'class-2'
    if g.sum() < 200:
        ground_method = 'lowest-point'
        lowest = np.full((G, G), np.inf)
        np.minimum.at(lowest, (gy, gx), z)
        lowest = ndimage.grey_opening(np.where(np.isfinite(lowest), lowest, np.nanmax(z)), size=(9, 9))
        g = z - lowest[gy, gx] < 0.3
    sums = np.zeros((G, G)); cnt = np.zeros((G, G))
    np.add.at(sums, (gy[g], gx[g]), z[g]); np.add.at(cnt, (gy[g], gx[g]), 1)
    dtm = np.where(cnt > 0, sums / np.maximum(cnt, 1), np.nan)
    have = np.isfinite(dtm)
    if (~have).any():
        yy, xx = np.nonzero(have)
        hy, hx = np.nonzero(~have)
        fill = griddata((yy, xx), dtm[have], (hy, hx), method='linear')
        bad = ~np.isfinite(fill)
        if bad.any():
            fill[bad] = griddata((yy, xx), dtm[have], (hy[bad], hx[bad]), method='nearest')
        dtm[hy, hx] = fill

    def ground_at(qx, qy):
        fx = np.clip((qx - x0) / GROUND_CELL_M - 0.5, 0, G - 1.001)
        fy = np.clip((qy - y0) / GROUND_CELL_M - 0.5, 0, G - 1.001)
        return ndimage.map_coordinates(dtm, [fy, fx], order=1, mode='nearest')

    hag = z - ground_at(x, y)

    # ---- 2-3 candidates and planarity
    cand = (hag >= MIN_HAG_M) & ~np.isin(cls, (2, 9))
    ci = np.nonzero(cand)[0]
    cxyz = np.column_stack([x[ci], y[ci], z[ci]])
    tree3 = cKDTree(cxyz)
    r_norm = max(NORMAL_R_MIN_M, 2.5 * spacing)
    normals, rms, counts = pca_normals(cxyz, tree3, r_norm)
    # one point per pulse that ended on a surface: a last (or only) return. A pulse that also returned earlier went
    # through something (a branch, or the eave's edge); the earlier returns are never a roof plane's seed or bridge.
    clast = (rn[ci] == nr[ci])
    planar = (rms <= PLANAR_RMS_M) & clast

    # ---- 4 region growing
    r_grow = max(0.6, 2.0 * spacing)
    label, nl = region_grow(cxyz, normals, rms, planar, tree3, r_grow)
    planes = []
    density_plan = max(pulse_density, 0.5)
    for k in range(nl):
        idx = np.nonzero(label == k)[0]
        if len(idx) < 6:
            label[idx] = -1
            continue
        c, nrm, prms = fit_plane(cxyz[idx])
        slope = math.degrees(math.acos(min(1.0, abs(nrm[2]))))
        hull_area = MultiPoint(cxyz[idx, :2]).convex_hull.area
        plan_m2 = min(hull_area, len(idx) / density_plan * 1.5)
        if plan_m2 < MIN_PLANE_M2 or slope > MAX_SLOPE_DEG or prms > PLANE_RMS_M:
            label[idx] = -1
            continue
        planes.append(dict(k=k, idx=idx, c=c, n=nrm, rms=prms, slope=slope))
    if not planes:
        return dict(slug=slug, ok=False, reason='no-roof-planes')

    # Attach the roof points the planarity test left out (ridges, hips, valleys and eaves straddle two planes or the
    # roof's end, so their neighbourhood is not one plane): a candidate within attach_r of a plane's point and within
    # ATTACH_DIST_M of that plane joins it, ATTACH_ROUNDS times. A branch above the roof is off the plane; the rounds
    # limit how far a roof can creep (about ATTACH_ROUNDS x attach_r). Done before the planes are linked, so a ridge
    # the planarity test emptied still joins its two faces.
    n_plane_pts = int(sum(len(p['idx']) for p in planes))
    attach_r = max(0.6, 1.5 * spacing)
    owner = np.full(len(cxyz), -1)
    for j, p in enumerate(planes):
        owner[p['idx']] = j
    for _ in range(ATTACH_ROUNDS):
        have_ = np.nonzero((owner >= 0) & clast)[0]  # an earlier return joins but never carries the roof further
        free = np.nonzero(owner < 0)[0]
        if len(free) == 0:
            break
        dd, nn = cKDTree(cxyz[have_]).query(cxyz[free], distance_upper_bound=attach_r)
        hit = np.isfinite(dd)
        add = []
        for f, j in zip(free[hit], have_[nn[hit]]):
            pl = planes[owner[j]]
            if abs((cxyz[f] - pl['c']) @ pl['n']) <= ATTACH_DIST_M:
                add.append((f, owner[j]))
        if not add:
            break
        for f, o in add:
            owner[f] = o
    for j, p in enumerate(planes):
        p['all'] = np.nonzero(owner == j)[0]

    # ---- 5 the house: nearest plane to the house point inside Google's box, then connected planes
    bi = json.load(open(f'{hd}/bi.json'))
    bb = bi['boundingBox']
    bsw = to_utm.transform(bb['sw']['longitude'], bb['sw']['latitude'])
    bne = to_utm.transform(bb['ne']['longitude'], bb['ne']['latitude'])
    gbox = sbox(bsw[0], bsw[1], bne[0], bne[1])
    plane_tree = {p['k']: cKDTree(cxyz[p['all'], :2]) for p in planes}

    def dist_to(p, qx, qy):
        return plane_tree[p['k']].query([qx, qy])[0]

    in_box = [p for p in planes if gbox.buffer(0.5).contains(Point(*cxyz[p['idx'], :2].mean(0))) or
              np.any((cxyz[p['idx'], 0] >= bsw[0]) & (cxyz[p['idx'], 0] <= bne[0]) & (cxyz[p['idx'], 1] >= bsw[1]) & (cxyz[p['idx'], 1] <= bne[1]))]
    if not in_box:
        return dict(slug=slug, ok=False, reason='no-plane-in-google-box')
    big = [p for p in in_box if MultiPoint(cxyz[p['all'], :2]).convex_hull.area >= SEED_MIN_M2]
    seed = min(big or in_box, key=lambda p: (round(dist_to(p, px, py), 3), -len(p['idx']), p['k']))
    # adjacency
    link = max(LINK_M, 2.0 * spacing)
    adj = {p['k']: set() for p in planes}
    for i, a in enumerate(planes):
        for b in planes[i + 1:]:
            ia, ib = cxyz[a['all'], :2], cxyz[b['all'], :2]
            if ia[:, 0].min() > ib[:, 0].max() + link or ib[:, 0].min() > ia[:, 0].max() + link:
                continue
            if ia[:, 1].min() > ib[:, 1].max() + link or ib[:, 1].min() > ia[:, 1].max() + link:
                continue
            dd, jj = plane_tree[b['k']].query(ia, distance_upper_bound=link)
            hit = np.isfinite(dd)
            # ... and at a height a roof can step by (one storey); a crown's flat patch 10 m up is not the roof's neighbour
            za = cxyz[a['all'], 2][hit]
            zb = cxyz[b['all'], 2][jj[hit]]
            touch = ia[hit][np.abs(za - zb) <= MAX_STEP_M]
            # a shared edge, not a stray point: LINK_MIN_POINTS points along at least LINK_MIN_LEN_M (a chain of
            # branch fragments under a crown between two houses touches at single points)
            if len(touch) >= LINK_MIN_POINTS and np.ptp(touch[:, 0]) ** 2 + np.ptp(touch[:, 1]) ** 2 >= LINK_MIN_LEN_M ** 2:
                adj[a['k']].add(b['k']); adj[b['k']].add(a['k'])
    # The building: faces of BIG_PLANE_M2 or more joined through each other (a chain of small patches, a vent, a branch
    # fragment or a shed between two houses, never joins them), then the small faces touching it, one step only.
    area_of = {p['k']: min(MultiPoint(cxyz[p['all'], :2]).convex_hull.area, len(p['all']) / density_plan) for p in planes}
    big_k = {k for k, a in area_of.items() if a >= BIG_PLANE_M2} | {seed['k']}
    comp, todo = {seed['k']}, [seed['k']]
    while todo:
        for nb in sorted(adj[todo.pop()]):
            if nb not in comp and nb in big_k:
                comp.add(nb); todo.append(nb)
    for k in sorted(comp):
        if k in big_k:
            comp |= {nb for nb in adj[k] if nb not in big_k}
    house = [p for p in planes if p['k'] in comp]
    if os.environ.get('TRUTH_DEBUG'):
        for p in house:
            q = cxyz[p['all']]
            print(f"  plane {p['k']:4d} n={len(p['idx']):5d}/{len(p['all']):5d} at ({q[:,0].mean()-px:6.1f},{q[:,1].mean()-py:6.1f}) slope {p['slope']:4.1f} rms {p['rms']:.3f} z {q[:,2].mean():.1f} links {sorted(adj[p['k']])}")
    hidx = np.concatenate([p['all'] for p in house])
    hlab = np.concatenate([np.full(len(p['all']), j) for j, p in enumerate(house)])
    # ---- 6 outline raster
    cx_ = ((cxyz[hidx, 0] - x0) / CELL_M).astype(int)
    cy_ = ((cxyz[hidx, 1] - y0) / CELL_M).astype(int)
    ok_ = (cx_ >= 0) & (cx_ < W) & (cy_ >= 0) & (cy_ < W)
    occ = np.zeros((W, W), bool)
    occ[cy_[ok_], cx_[ok_]] = True
    close_r = max(1, int(math.ceil(max(MIN_CLOSE_M, 1.5 * spacing) / CELL_M)))
    disk = np.hypot(*np.mgrid[-close_r:close_r + 1, -close_r:close_r + 1]) <= close_r + 1e-9
    m = ndimage.binary_closing(np.pad(occ, close_r + 2), structure=disk)[close_r + 2:-close_r - 2, close_r + 2:-close_r - 2]
    m = ndimage.binary_fill_holes(m)
    # Cut necks: a strip narrower than 2 x NECK_M joining the house to something else (a fence top, a pergola, a
    # neighbour's carport) is opened away; the part holding the seed face is kept and grown back by NECK_M inside the
    # original mask, so its own edges are untouched.
    nr_ = max(1, int(round(NECK_M / CELL_M)))
    ndisk = np.hypot(*np.mgrid[-nr_:nr_ + 1, -nr_:nr_ + 1]) <= nr_ + 1e-9
    mo = ndimage.binary_opening(m, structure=ndisk)
    lab_, nlab = ndimage.label(mo)
    sx_ = ((cxyz[seed['idx'], 0] - x0) / CELL_M).astype(int)
    sy_ = ((cxyz[seed['idx'], 1] - y0) / CELL_M).astype(int)
    okk = (sx_ >= 0) & (sx_ < W) & (sy_ >= 0) & (sy_ < W)
    seed_labels = lab_[sy_[okk], sx_[okk]]
    seed_labels = seed_labels[seed_labels > 0]
    if len(seed_labels):
        keep_lab = np.bincount(seed_labels).argmax()
        m = m & ndimage.binary_dilation(lab_ == keep_lab, structure=ndisk)
    lab_, nlab = ndimage.label(m)
    if nlab > 1:
        sizes = ndimage.sum(m, lab_, range(1, nlab + 1))
        m = lab_ == (int(np.argmax(sizes)) + 1)
    # grow by half a spacing: distance (m) from the occupied cells' centres
    edt = ndimage.distance_transform_edt(~m) * CELL_M
    grow = 0.5 * spacing
    mg = edt <= grow + 1e-9
    # sub-cell contour of a smooth field: signed distance to the grown mask (0.5 level on a 0/1 map is the cell edge)
    field = np.where(mg, 1.0, 0.0)
    contours = measure.find_contours(np.pad(field, 1), 0.5)
    polys = []
    for cpts in contours:
        if len(cpts) < 4:
            continue
        xs = x0 + (cpts[:, 1] - 1 + 0.5) * CELL_M
        ys = y0 + (cpts[:, 0] - 1 + 0.5) * CELL_M
        pg = Polygon(np.column_stack([xs, ys]))
        if pg.is_valid and pg.area > 0:
            polys.append(pg)
    if not polys:
        return dict(slug=slug, ok=False, reason='no-outline')
    # outer rings minus inner rings (find_contours returns both): even-odd by containment
    polys.sort(key=lambda p: -p.area)
    outline = unary_union([p for p in polys if sum(1 for q in polys if q is not p and q.area > p.area and q.contains(p.representative_point())) % 2 == 0])
    holes = [p for p in polys if sum(1 for q in polys if q is not p and q.area > p.area and q.contains(p.representative_point())) % 2 == 1]
    if holes:
        outline = outline.difference(unary_union(holes))
    outline = outline.simplify(SIMPLIFY_M, preserve_topology=True)
    if isinstance(outline, MultiPolygon):
        parts = sorted(outline.geoms, key=lambda p: -p.area)
    else:
        parts = [outline]

    # ---- 7 planes: pitch, azimuth, plan and sloped area (outline cells to the nearest plane point)
    rr, cc = np.nonzero(mg)
    cell_xy = np.column_stack([x0 + (cc + 0.5) * CELL_M, y0 + (rr + 0.5) * CELL_M])
    ht = cKDTree(cxyz[hidx, :2])
    _, near = ht.query(cell_xy)
    cell_plane = hlab[near]
    plane_out = []
    total_sloped = 0.0
    for j, p in enumerate(house):
        nrm = p['n']
        slope = math.degrees(math.acos(min(1.0, abs(nrm[2]))))
        pitch = 12 * math.tan(math.radians(slope))
        az = (math.degrees(math.atan2(nrm[0], nrm[1])) + 360) % 360 if slope > 0.5 else None  # downslope direction, compass
        plan = float((cell_plane == j).sum() * CELL_M * CELL_M)
        sloped = plan / max(math.cos(math.radians(slope)), 0.05)
        total_sloped += sloped
        ring_cells = cell_xy[cell_plane == j]
        plane_out.append(dict(pitchX12=round(pitch, 3), slopeDeg=round(slope, 2), azimuthDeg=None if az is None else round(az, 1), planM2=round(plan, 2),
                              slopedM2=round(sloped, 2), points=int(len(p['idx'])), rmsM=round(p['rms'], 3), meanHagM=round(float(np.mean(hag[ci[p['idx']]])), 2),
                              cells=None, centroid=[round(float(v), 2) for v in p['c'][:2]]))
        plane_out[-1]['_cells'] = ring_cells

    # ---- 8 registration to Google's frame
    dsm = dsm.astype(float)
    dsm[(dsm < -1000) | ~np.isfinite(dsm)] = np.nan
    roof_all = np.nonzero(label >= 0)[0]  # every planar roof point in the crop (all buildings: more frame evidence)
    rx, ry, rz = cxyz[roof_all, 0], cxyz[roof_all, 1], cxyz[roof_all, 2]

    def sample_dsm(qx, qy):
        cols = (qx - gtf['ox']) / gtf['sx'] - 0.5
        rows = (gtf['oy'] - qy) / gtf['sy'] - 0.5
        inside = (cols >= 0) & (cols <= dsm.shape[1] - 1) & (rows >= 0) & (rows <= dsm.shape[0] - 1)
        out = np.full(len(qx), np.nan)
        out[inside] = ndimage.map_coordinates(np.nan_to_num(dsm, nan=-9999.0), [rows[inside], cols[inside]], order=1)
        out[out < -1000] = np.nan
        return out

    def score(dx, dy):
        s = sample_dsm(rx + dx, ry + dy)
        r = rz - s
        r = r[np.isfinite(r)]
        if len(r) < 50:
            return np.inf, np.nan, 0
        med = np.median(r)
        return float(np.median(np.abs(r - med))), float(med), len(r)

    best = (np.inf, 0.0, 0.0, np.nan)
    grid = np.arange(-MAX_SHIFT_M, MAX_SHIFT_M + 1e-9, 0.25)
    for dx in grid:
        for dy in grid:
            sc, med, nn = score(dx, dy)
            if sc < best[0] - 1e-12:
                best = (sc, dx, dy, med)
    fine = np.arange(-0.25, 0.25 + 1e-9, 0.05)
    b0 = best
    for ddx in fine:
        for ddy in fine:
            sc, med, nn = score(b0[1] + ddx, b0[2] + ddy)
            if sc < best[0] - 1e-12:
                best = (sc, b0[1] + ddx, b0[2] + ddy, med)
    reg_mad, sdx, sdy, dz = best
    reg = dict(dxM=round(float(sdx), 3), dyM=round(float(sdy), 3), dzM=round(float(dz), 3), madM=round(float(reg_mad), 4),
               zeroShiftMadM=round(score(0, 0)[0], 4), atLimit=bool(abs(sdx) >= MAX_SHIFT_M - 0.3 or abs(sdy) >= MAX_SHIFT_M - 0.3), points=int(len(rx)))
    # Conditioning: the fit must get worse when the shift moves REG_PROBE_M along either axis, else the roofs in the
    # crop do not pin the frame in that direction (one long gable fixes nothing along its ridge).
    rise = min(score(sdx + ex, sdy + ey)[0] - reg_mad for ex, ey in ((REG_PROBE_M, 0), (-REG_PROBE_M, 0), (0, REG_PROBE_M), (0, -REG_PROBE_M)))
    reg['probeRiseM'] = round(float(rise), 4)
    reg['conditioned'] = bool(rise >= REG_MIN_RISE_M)

    # ---- 9 self-checks
    shifted = [Polygon(np.asarray(p.exterior.coords) + [sdx, sdy], [np.asarray(h.coords) + [sdx, sdy] for h in p.interiors]) for p in parts]
    main = parts[0]
    # roof point density (pulses per m2 over the house's roof)
    hcx = ((cxyz[hidx, 0] - x0) / CELL_M).astype(int)
    hcy = ((cxyz[hidx, 1] - y0) / CELL_M).astype(int)
    inm = (hcx >= 0) & (hcx < W) & (hcy >= 0) & (hcy < W)
    inm[inm] = mg[hcy[inm], hcx[inm]]
    house_density = int(inm.sum()) / max(sum(p.area for p in parts), 1)
    # edge observation: along the (unshifted, lidar-frame) outline, lidar saw past the eave: a return 0.3-1.5 m
    # outside it at least EDGE_DROP_M below the roof's edge (the ground, a lawn, a shrub under the eave), not only
    # things as high as the roof or higher (a crown, or nothing at all because the pulses never got through)
    low = (hag < LOW_HAG_M)
    lt = cKDTree(np.column_stack([x[low], y[low]]))
    at = cKDTree(np.column_stack([x, y]))
    rt = cKDTree(cxyz[hidx, :2])
    ring = np.asarray(main.exterior.coords)
    ccw = Polygon(ring).exterior.is_ccw
    samples, observed = 0, 0
    obs_flags = []
    for i in range(len(ring) - 1):
        a, b = ring[i], ring[i + 1]
        seg = b - a
        ln = float(np.hypot(*seg))
        if ln < 1e-6:
            continue
        t = seg / ln
        out = np.array([t[1], -t[0]]) if ccw else np.array([-t[1], t[0]])  # outward normal
        for s in np.arange(EDGE_STEP_M / 2, ln, EDGE_STEP_M):
            q = a + t * s
            mid = q + out * (EDGE_OUT_M[0] + EDGE_OUT_M[1]) / 2
            dz_, j_ = rt.query(q)
            z_edge = cxyz[hidx[j_], 2]
            hits = at.query_ball_point(mid, (EDGE_OUT_M[1] - EDGE_OUT_M[0]) / 2 + 0.25)
            ok = False
            for h in sorted(hits):
                if z[h] <= z_edge - EDGE_DROP_M and not main.contains(Point(x[h], y[h])):
                    ok = True
                    break
            samples += 1
            observed += ok
            obs_flags.append(ok)
    edge_observed = observed / max(samples, 1)

    # change between captures: lidar roof cells where Google's heights are at the ground, and Google roof-like heights
    # inside Google's box where lidar sees the ground (all in the registered frame)
    gh_at = sample_dsm(cell_xy[:, 0] + sdx, cell_xy[:, 1] + sdy) + dz - ground_at(cell_xy[:, 0], cell_xy[:, 1])
    valid = np.isfinite(gh_at)
    google_ground_in_lidar_roof = float(np.mean(gh_at[valid] < LOW_HAG_M)) if valid.any() else None
    # roof height agreement on the house's points
    hz = sample_dsm(cxyz[hidx, 0] + sdx, cxyz[hidx, 1] + sdy) + dz
    dd = cxyz[hidx, 2] - hz
    dd = dd[np.isfinite(dd)]
    roof_height_mad = float(np.median(np.abs(dd))) if len(dd) else None
    # Google roof-like where lidar is ground: Google box cells, Google HAG >= 2 m and smooth, lidar low returns there
    gb = gbox
    bx = np.arange(gb.bounds[0], gb.bounds[2], CELL_M) + CELL_M / 2
    byy = np.arange(gb.bounds[1], gb.bounds[3], CELL_M) + CELL_M / 2
    BX, BY = np.meshgrid(bx, byy)
    BX, BY = BX.ravel(), BY.ravel()  # Google frame
    gz = sample_dsm(BX, BY) + dz
    lx, ly = BX - sdx, BY - sdy      # lidar frame
    ghag = gz - ground_at(lx, ly)
    near_low = lt.query(np.column_stack([lx, ly]), distance_upper_bound=0.4)[0]
    any_pt = cKDTree(np.column_stack([x, y])).query(np.column_stack([lx, ly]), distance_upper_bound=0.4)[0]
    # lidar sees ground there: the nearest return within 0.4 m is ground-level and no higher return is within 0.4 m
    hi = ~low
    ht_ = cKDTree(np.column_stack([x[hi], y[hi]]))
    near_hi = ht_.query(np.column_stack([lx, ly]), distance_upper_bound=0.4)[0]
    lidar_ground = np.isfinite(near_low) & ~np.isfinite(near_hi)
    seen = np.isfinite(any_pt)  # lidar has a return within 0.4 m (sparse projects leave cells empty: not evidence)
    google_roof = np.isfinite(ghag) & (ghag >= 2.0) & seen
    google_roof_where_lidar_ground = float(np.mean(lidar_ground[google_roof])) if google_roof.any() else None

    # ---- outputs
    def ll_ring(coords):
        lo, la = to_ll.transform(coords[:, 0], coords[:, 1])
        return [[round(float(a), 8), round(float(b), 8)] for a, b in zip(lo, la)]

    out_parts = []
    for p in shifted:
        out_parts.append(dict(outer=ll_ring(np.asarray(p.exterior.coords)), holes=[ll_ring(np.asarray(h.coords)) for h in p.interiors]))
    # planes: their cell polygons (union of cells) for pitch matching, in the registered frame
    for po in plane_out:
        cells = po.pop('_cells')
        if len(cells) == 0:
            po['rings'] = []
            continue
        sq = unary_union([sbox(cx0 - CELL_M / 2, cy0 - CELL_M / 2, cx0 + CELL_M / 2, cy0 + CELL_M / 2) for cx0, cy0 in cells]).simplify(0.05)
        geoms = sq.geoms if isinstance(sq, MultiPolygon) else [sq]
        po['rings'] = [ll_ring(np.asarray(gp.exterior.coords) + [sdx, sdy]) for gp in geoms if gp.area >= 0.25]
        po.pop('cells', None)
    plane_out = [po for po in plane_out if po['planM2'] > 0]
    main_pitch = None
    acc = {}
    for po in plane_out:
        if po['pitchX12'] >= 1.0:
            k = int(np.round(po['pitchX12']))
            acc[k] = acc.get(k, 0) + po['slopedM2']
    if acc:
        main_pitch = max(sorted(acc), key=lambda k: acc[k])
    res = dict(
        slug=slug, ok=True, version=1,
        source=dict(project=meta['project'], workunit=meta['workunit'], ql=meta['ql'], collect=meta['collect'], pointDates=meta['pointDates'],
                    leafOffUnit=meta['leafOffUnit'], credit=meta['credit'], kind=meta['source']['kind']),
        method=dict(cellM=CELL_M, spacingM=round(spacing, 3), closeRadiusM=close_r * CELL_M, growM=round(grow, 3), simplifyM=SIMPLIFY_M, ground=ground_method,
                    expectedEdgeErrorM=round(0.5 / math.sqrt(max(house_density, 0.1)) + 0.5 * CELL_M, 3)),
        frame=reg,
        outline=out_parts,
        planAreaM2=round(sum(p.area for p in parts), 2),
        slopedAreaM2=round(total_sloped, 2),
        mainPitchX12=main_pitch,
        planes=plane_out,
        checks=dict(pulseDensity=round(pulse_density, 2), planePoints=int(n_plane_pts), roofPointsPerM2=round(house_density, 2), roofPoints=int(inm.sum()), planes=len(house),
                    edgeObservedShare=round(edge_observed, 4), edgeSamples=samples, googleBoxAreaM2=round(gbox.area, 2),
                    footprintOverBox=round(main.area / max(gbox.area, 1), 3),
                    googleGroundInLidarRoof=None if google_ground_in_lidar_roof is None else round(google_ground_in_lidar_roof, 4),
                    googleRoofWhereLidarGround=None if google_roof_where_lidar_ground is None else round(google_roof_where_lidar_ground, 4),
                    roofHeightMadM=None if roof_height_mad is None else round(roof_height_mad, 3)),
    )
    with open(out_path or f'{d}/truth.json', 'w') as fh:
        json.dump(res, fh, indent=1, sort_keys=True)
    if write_png:
        png(d, hd, x, y, hag, x0, y0, meta['halfM'], parts, gbox, label, ci, (sdx, sdy))
    return res


def png(d, hd, x, y, hag, x0, y0, half, parts, gbox, label, ci, shift):
    """Diagnostic: lidar max height above ground (roof points blue), Google's photo; outline red, Google box yellow."""
    import imageio.v3 as iio
    S = 0.2
    N = int(2 * half / S)
    a = np.zeros((N, N, 3), np.uint8)
    cx = np.clip(((x - x0) / S).astype(int), 0, N - 1)
    cy = np.clip(((y - y0) / S).astype(int), 0, N - 1)
    mx = np.full((N, N), -1.0)
    np.maximum.at(mx, (N - 1 - cy, cx), hag)
    v = np.clip(mx / 10 * 230 + 25, 0, 255).astype(np.uint8)
    a[..., 0] = a[..., 1] = a[..., 2] = np.where(mx >= 0, v, 0)
    roof = ci[label >= 0]
    a[N - 1 - cy[roof], cx[roof]] = [60, 140, 255]
    rgb, tf = read_geotiff(f'{hd}/rgb.tif')
    b = np.zeros((N, N, 3), np.uint8)
    gx = x0 + shift[0] + (np.arange(N) + 0.5) * S
    gy = y0 + shift[1] + (N - 1 - np.arange(N) + 0.5) * S
    cols = ((gx - tf['ox']) / tf['sx']).astype(int)
    rows = ((tf['oy'] - gy) / tf['sy']).astype(int)
    R_, C_ = np.meshgrid(rows, cols, indexing='ij')
    ok = (R_ >= 0) & (R_ < rgb.shape[0]) & (C_ >= 0) & (C_ < rgb.shape[1])
    b[ok] = rgb[R_[ok], C_[ok]][..., :3]

    def draw(img, coords, col, dx=0.0, dy=0.0):
        for p_, q_ in zip(coords[:-1], coords[1:]):
            for t in np.linspace(0, 1, int(np.hypot(*(q_ - p_)) / S * 2) + 2):
                q = p_ + (q_ - p_) * t
                i, j = int((q[0] - dx - x0) / S), int((q[1] - dy - y0) / S)
                if 0 <= i < N and 0 <= j < N:
                    img[N - 1 - j, i] = col

    for p in parts:
        draw(a, np.asarray(p.exterior.coords), [255, 40, 40])
        draw(b, np.asarray(p.exterior.coords), [255, 40, 40])
    draw(a, np.asarray(gbox.exterior.coords), [255, 220, 0], *shift)
    draw(b, np.asarray(gbox.exterior.coords), [255, 220, 0], *shift)
    iio.imwrite(f'{d}/truth.png', np.concatenate([a, np.full((N, 4, 3), 255, np.uint8), b], axis=1))


def main(slugs):
    import glob
    m = json.load(open(f'{R}/manifest.json'))
    for h in m['houses']:
        if slugs and h['slug'] not in slugs:
            continue
        for d in sorted(glob.glob(f'{L}/{h["slug"]}/units/*/points.npz')):
            d = os.path.dirname(d)
            unit = os.path.basename(d)
            try:
                r = run(h['slug'], h['set'], h['point'], d)
            except Exception as e:  # noqa: BLE001
                r = dict(slug=h['slug'], ok=False, reason=f'error {type(e).__name__}: {e}')
            if not r['ok']:
                json.dump(r, open(f'{d}/truth.json', 'w'), indent=1)
                print(h['slug'], unit, 'FAILED', r['reason'], flush=True)
                continue
            c = r['checks']
            print(h['slug'], unit, 'plan', r['planAreaM2'], 'pitch', r['mainPitchX12'], 'dens', c['roofPointsPerM2'], 'edgeObs', c['edgeObservedShare'],
                  'shift', (r['frame']['dxM'], r['frame']['dyM']), 'mad', r['frame']['madM'], 'chg', c['googleGroundInLidarRoof'], c['googleRoofWhereLidarGround'], flush=True)


if __name__ == '__main__':
    main(sys.argv[1:])
