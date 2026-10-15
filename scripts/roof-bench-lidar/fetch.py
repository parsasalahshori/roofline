"""Fetch 3DEP lidar points around every benchmark house (the work unit coverage.py picked).

EPT (Entwine, AWS usgs-lidar-public): only the octree nodes whose cube meets the house box are read (small). Otherwise
the TNM LAZ tile(s), downloaded once into lidar/tiles/ and cropped. Every house gets lidar/<slug>/points.npz in the
house's WGS84 UTM zone (x, y, z metres, classification, return number, number of returns, gps time, intensity) and
lidar/<slug>/fetch.json (what was read, from where, CRS, units). A ledger of every download is kept in
lidar/ledger.json. USGS 3DEP data, public domain.

Usage: python -I fetch.py [slug ...]
"""
import concurrent.futures as cf, hashlib, io, json, math, os, sys, time, urllib.request, datetime
import numpy as np, laspy
from pyproj import CRS, Transformer

R = os.environ.get('ROOF_BENCH_DIR', '/Users/parsasalahshori-a/RooflineWork/roof-bench')
L = f'{R}/lidar'
HALF_M = 35.0          # the crop: a 70 m square round the house point (the house plus its yard and trees)
MAX_TOTAL_BYTES = 20e9  # the whole lidar folder's download budget
UA = {'User-Agent': 'roof-bench-lidar/1'}


def ledger_add(entry):
    p = f'{L}/ledger.json'
    led = json.load(open(p)) if os.path.exists(p) else {'downloads': []}
    led['downloads'].append(entry)
    led['totalBytes'] = sum(d['bytes'] for d in led['downloads'])
    json.dump(led, open(p, 'w'), indent=1)
    return led['totalBytes']


def total_bytes():
    p = f'{L}/ledger.json'
    return json.load(open(p)).get('totalBytes', 0) if os.path.exists(p) else 0


def http(url, tries=4):
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise
            if k == tries - 1:
                raise
        except Exception:
            if k == tries - 1:
                raise
        time.sleep(2 + 4 * k)


def utm_epsg(lng, lat):
    zone = int((lng + 180) // 6) + 1
    return (32600 if lat >= 0 else 32700) + zone


def gps_dates(t, adjusted=True):
    if t is None or len(t) == 0:
        return None
    base = datetime.datetime(1980, 1, 6, tzinfo=datetime.UTC)
    off = 1e9 if adjusted else 0.0
    q = np.quantile(t, [0.0, 0.5, 1.0])
    if adjusted and q[1] < -1e9:  # not adjusted after all
        off = 0
    out = []
    for v in q:
        try:
            out.append((base + datetime.timedelta(seconds=float(v) + off)).date().isoformat())
        except OverflowError:
            out.append(None)
    return out


# ---------------------------------------------------------------- EPT

def ept_points(ept_url, lng, lat):
    root = ept_url.rsplit('/', 1)[0]
    meta = json.loads(http(ept_url))
    srs = meta['srs']
    src = CRS.from_wkt(srs['wkt']) if srs.get('wkt') else CRS.from_epsg(int(srs['horizontal']))
    to_src = Transformer.from_crs(4326, src, always_xy=True)
    # box in EPT coordinates: transform the corners of the ground box (metres east/north of the point)
    utm = utm_epsg(lng, lat)
    to_utm = Transformer.from_crs(4326, utm, always_xy=True)
    ux, uy = to_utm.transform(lng, lat)
    back = Transformer.from_crs(utm, src, always_xy=True)
    cx, cy = back.transform([ux - HALF_M, ux + HALF_M, ux - HALF_M, ux + HALF_M], [uy - HALF_M, uy - HALF_M, uy + HALF_M, uy + HALF_M])
    bx0, bx1, by0, by1 = min(cx), max(cx), min(cy), max(cy)
    b = meta['bounds']
    nodes = []
    hier_cache = {}

    def hier(key):
        if key not in hier_cache:
            hier_cache[key] = json.loads(http(f'{root}/ept-hierarchy/{key}.json'))
        return hier_cache[key]

    def walk(d, x, y, z, h):
        key = f'{d}-{x}-{y}-{z}'
        if key not in h:
            return
        n = h[key]
        size = (b[3] - b[0]) / 2 ** d
        x0, y0 = b[0] + x * size, b[1] + y * size
        if x0 > bx1 or x0 + size < bx0 or y0 > by1 or y0 + size < by0:
            return
        if n == -1:
            h = hier(key)
            n = h[key]
        if n > 0:
            nodes.append(key)
        for dx in (0, 1):
            for dy in (0, 1):
                for dz in (0, 1):
                    walk(d + 1, 2 * x + dx, 2 * y + dy, 2 * z + dz, h)

    walk(0, 0, 0, 0, hier('0-0-0-0'))
    nbytes = 0

    def one(key):
        data = http(f'{root}/ept-data/{key}.laz')
        las = laspy.read(io.BytesIO(data))
        x, y = np.asarray(las.x), np.asarray(las.y)
        k = (x >= bx0) & (x <= bx1) & (y >= by0) & (y <= by1)
        return key, len(data), {n: np.asarray(getattr(las, n))[k] for n in ('x', 'y', 'z', 'classification', 'return_number', 'number_of_returns', 'gps_time', 'intensity')}

    parts = []
    with cf.ThreadPoolExecutor(8) as ex:
        for key, size, arr in ex.map(one, nodes):
            nbytes += size
            parts.append(arr)
    pts = {n: np.concatenate([p[n] for p in parts]) for n in parts[0]}
    ledger_add(dict(url=f'{root}/ept-data/*.laz', nodes=len(nodes), bytes=nbytes, what='ept-nodes', at=datetime.datetime.now(datetime.UTC).isoformat(timespec='seconds')))
    return pts, src, dict(kind='ept', url=ept_url, nodes=len(nodes), bytes=nbytes, srs=srs.get('horizontal'), zUnitsToM=1.0)


# ---------------------------------------------------------------- tiles

def tile_path(url):
    return f'{L}/tiles/{url.rsplit("/", 1)[1]}'


def head_size(url):
    req = urllib.request.Request(url, headers=UA, method='HEAD')
    with urllib.request.urlopen(req, timeout=60) as r:
        return int(r.headers['Content-Length'])


def get_range(url, a, b, tries=6):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={**UA, 'Range': f'bytes={a}-{b}'})
            with urllib.request.urlopen(req, timeout=120) as r:
                data = r.read()
            if len(data) == b - a + 1:
                return data
        except Exception:
            if k == tries - 1:
                raise
        time.sleep(1 + 2 * k)
    raise RuntimeError(f'range {a}-{b} incomplete')


PART = 4 << 20   # 4 MB ranges, RANGE_THREADS at once: the server gives each connection about 0.3 MB/s
RANGE_THREADS = 16


def get_tile(url, size_hint):
    """The tile, downloaded once (parallel byte ranges) into lidar/tiles/ and reused; its sha1 goes in the ledger."""
    p = tile_path(url)
    if os.path.exists(p) and os.path.getsize(p) > 0:
        return p, 0
    size = head_size(url)
    if total_bytes() + size > MAX_TOTAL_BYTES:
        raise RuntimeError('download budget exceeded')
    tmp = p + '.part'
    with open(tmp, 'wb') as f:
        f.truncate(size)
    spans = [(a, min(size, a + PART) - 1) for a in range(0, size, PART)]

    def one(span):
        data = get_range(url, *span)
        with open(tmp, 'r+b') as f:
            f.seek(span[0])
            f.write(data)
        return len(data)

    with cf.ThreadPoolExecutor(RANGE_THREADS) as ex:
        n = sum(ex.map(one, spans))
    h = hashlib.sha1()
    with open(tmp, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    os.replace(tmp, p)
    ledger_add(dict(url=url, bytes=n, sha1=h.hexdigest(), what='laz-tile', at=datetime.datetime.now(datetime.UTC).isoformat(timespec='seconds')))
    return p, n


def z_factor(crs):
    """Metres per z unit: the vertical axis unit of a compound CRS, else the horizontal unit (US survey foot tiles)."""
    try:
        for sub in crs.sub_crs_list or []:
            if sub.is_vertical:
                return sub.axis_info[0].unit_conversion_factor
        return crs.axis_info[0].unit_conversion_factor
    except Exception:
        return 1.0


def tile_points(tiles, lng, lat):
    parts, info = [], []
    src = None
    for t in tiles:
        p, n = get_tile(t['url'], t.get('bytes'))
        with laspy.open(p) as f:
            crs = f.header.parse_crs()
            if crs is None:
                raise RuntimeError(f'no CRS in {os.path.basename(p)}')
            src = crs
            hcrs = crs.sub_crs_list[0] if crs.is_compound else crs
            utm = utm_epsg(lng, lat)
            ux, uy = Transformer.from_crs(4326, utm, always_xy=True).transform(lng, lat)
            back = Transformer.from_crs(utm, hcrs, always_xy=True)
            cx, cy = back.transform([ux - HALF_M, ux + HALF_M, ux - HALF_M, ux + HALF_M], [uy - HALF_M, uy - HALF_M, uy + HALF_M, uy + HALF_M])
            bx0, bx1, by0, by1 = min(cx), max(cx), min(cy), max(cy)
            for chunk in f.chunk_iterator(2_000_000):
                x, y = np.asarray(chunk.x), np.asarray(chunk.y)
                k = (x >= bx0) & (x <= bx1) & (y >= by0) & (y <= by1)
                if k.any():
                    parts.append({n_: np.asarray(getattr(chunk, n_))[k] for n_ in ('x', 'y', 'z', 'classification', 'return_number', 'number_of_returns', 'gps_time', 'intensity')})
            info.append(dict(url=t['url'], bytes=os.path.getsize(p), downloaded=n))
    if not parts:
        raise RuntimeError('no points in the box')
    pts = {n: np.concatenate([p[n] for p in parts]) for n in parts[0]}
    return pts, src, dict(kind='tile', tiles=info, srs=src.to_epsg() or src.name, zUnitsToM=z_factor(src))


def fetch_unit(slug, c, u, out_dir):
    lng, lat = c['point']
    if u['ept']:
        pts, src, info = ept_points(u['ept'][0]['url'], lng, lat)
    else:
        pts, src, info = tile_points(u['tiles'], lng, lat)
    hcrs = src.sub_crs_list[0] if src.is_compound else src
    utm = utm_epsg(lng, lat)
    tr = Transformer.from_crs(hcrs, utm, always_xy=True)
    x, y = tr.transform(pts['x'], pts['y'])
    z = pts['z'] * info['zUnitsToM']
    os.makedirs(out_dir, exist_ok=True)
    np.savez_compressed(f'{out_dir}/points.npz', x=np.asarray(x), y=np.asarray(y), z=np.asarray(z), cls=pts['classification'].astype(np.uint8),
                        rn=pts['return_number'].astype(np.uint8), nr=pts['number_of_returns'].astype(np.uint8), t=pts['gps_time'], i=pts['intensity'].astype(np.uint16))
    dates = gps_dates(pts['gps_time'])
    meta = dict(slug=slug, workunit=u['workunit'], project=u['project'], ql=u['ql'], spec=u['spec'], collect=[u['start'], u['end']], leafOffUnit=u['leafOff'],
                pointDates=dates, utmEpsg=utm, halfM=HALF_M, points=int(len(x)), source=info, credit='USGS 3D Elevation Program (3DEP), public domain')
    json.dump(meta, open(f'{out_dir}/fetch.json', 'w'), indent=1)
    print(slug, u['workunit'], info['kind'], len(x), 'pts', 'dates', dates, f"total {total_bytes()/1e9:.2f} GB", flush=True)


def usable(u):
    """A work unit worth fetching: QL2 or better (QL0-QL2) with its point cloud published."""
    import re
    m = re.search(r'(\d)', u['ql'] or '')
    return bool(m) and int(m.group(1)) <= 2 and bool(u['tiles'] or u['ept'])


def main(args):
    """Every usable work unit of every house goes to lidar/<slug>/units/<workunit>/ (truth is built for each and
    choose.py picks one by the truth's own checks). Pass slugs to limit; --primary fetches only coverage.py's pick."""
    primary = '--primary' in args
    slugs = [a for a in args if not a.startswith('--')]
    cov = json.load(open(f'{L}/coverage.json'))
    for slug, c in cov.items():
        if slugs and slug not in slugs:
            continue
        units = [u for u in c['units'] if usable(u) and (not primary or u['workunit'] == c['pick'])]
        for u in units:
            out_dir = f'{L}/{slug}/units/{u["workunit"]}'
            if os.path.exists(f'{out_dir}/points.npz'):
                continue
            try:
                fetch_unit(slug, c, u, out_dir)
            except Exception as e:  # noqa: BLE001
                print(slug, u['workunit'], 'FAILED', type(e).__name__, str(e)[:200], flush=True)


if __name__ == '__main__':
    main(sys.argv[1:])
