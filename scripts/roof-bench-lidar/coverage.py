"""3DEP lidar coverage of every benchmark house.

For each house point: the USGS 3DEP Elevation Index (WESM, layer 8 'Lidar Point Cloud') work units over it (project,
flight dates, quality level), the TNM Access LPC tiles that hold it (download URLs, sizes), and the Entwine EPT
resources (hobu usgs-lidar resources.geojson) that contain it. Picks one work unit per house:
  1. quality QL2 or better (QL0, QL1, QL2) with point cloud published (a TNM tile or an EPT resource),
  2. leaf-off (every flight day in Nov..Apr) before leaf-on/unknown,
  3. newest (collect_end) first.
Writes lidar/coverage.json. Network only to USGS/AWS public endpoints; no Google calls. Public domain data (USGS).
"""
import datetime, json, os, re, sys, time, urllib.parse, urllib.request
from shapely.geometry import shape, Point

R = os.environ.get('ROOF_BENCH_DIR', '/Users/parsasalahshori-a/RooflineWork/roof-bench')
WESM = 'https://index.nationalmap.gov/arcgis/rest/services/3DEPElevationIndex/MapServer/8/query'
TNM = 'https://tnmaccess.nationalmap.gov/api/v1/products'
LEAF_OFF_MONTHS = {11, 12, 1, 2, 3, 4}


def get(url, params, tries=4):
    q = url + '?' + urllib.parse.urlencode(params)
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(q, headers={'User-Agent': 'roof-bench-lidar/1'}), timeout=60) as r:
                return json.loads(r.read())
        except Exception as e:  # noqa: BLE001
            if k == tries - 1:
                raise
            time.sleep(2 + 3 * k)


def day(ms):
    return None if ms is None else datetime.datetime.fromtimestamp(ms / 1000, datetime.UTC).date().isoformat()


def leaf_off(start, end):
    """True when every day from start to end falls in Nov..Apr (a span under ~6 months that never enters May..Oct)."""
    if start is None or end is None:
        return None
    d0 = datetime.date.fromisoformat(start)
    d1 = datetime.date.fromisoformat(end)
    d = d0
    while d <= d1:
        if d.month not in LEAF_OFF_MONTHS:
            return False
        d += datetime.timedelta(days=7)
    return d1.month in LEAF_OFF_MONTHS


def ql_rank(ql):
    m = re.search(r'(\d)', ql or '')
    return int(m.group(1)) if m else 9


def main():
    res = json.load(open(f'{R}/lidar/sources/resources.geojson'))
    ept = [(f['properties'], shape(f['geometry'])) for f in res['features']]
    m = json.load(open(f'{R}/manifest.json'))
    out = {}
    for h in m['houses']:
        lng, lat = h['point']
        pt = Point(lng, lat)
        w = get(WESM, dict(geometry=f'{lng},{lat}', geometryType='esriGeometryPoint', inSR=4326, spatialRel='esriSpatialRelIntersects', outFields='*', returnGeometry='false', f='json'))
        d = 0.0004  # ~40 m box: the tiles under the house and its 30 m surround
        t = get(TNM, {'datasets': 'Lidar Point Cloud (LPC)', 'bbox': f'{lng-d},{lat-d},{lng+d},{lat+d}', 'max': 200, 'outputFormat': 'JSON'})
        tiles = [dict(title=i['title'], url=i['downloadURL'], bytes=i.get('sizeInBytes'), published=i.get('publicationDate'), bbox=i.get('boundingBox')) for i in t.get('items', [])]
        epts = [dict(name=p['name'], url=p['url'], count=p['count']) for p, g in ept if g.contains(pt)]
        units = []
        for f in w.get('features', []):
            a = f['attributes']
            s, e = day(a['collect_start']), day(a['collect_end'])
            wu, proj = a['workunit'], a['project']
            mine = [x for x in tiles if f'/{wu}/' in x['url'] or (proj in x['url'] and wu in x['url'])]
            ep = [x for x in epts if wu in x['name'] or x['name'] == wu or wu.replace('_', '') in x['name'].replace('_', '')]
            units.append(dict(workunit=wu, project=proj, start=s, end=e, ql=a['ql'], spec=a['spec'], method=a['p_method'], horizCrs=a['horiz_crs'], vertCrs=a['vert_crs'],
                              lpcCategory=a['lpc_category'], lpcLink=a['lpc_link'], leafOff=leaf_off(s, e), tiles=mine, ept=ep))
        ok = [u for u in units if (u['tiles'] or u['ept']) and ql_rank(u['ql']) <= 2]
        ok.sort(key=lambda u: (0 if u['leafOff'] else 1, -(int(u['end'].replace('-', '')) if u['end'] else 0)))
        pick = ok[0] if ok else None
        out[h['slug']] = dict(point=h['point'], units=units, pick=None if pick is None else pick['workunit'],
                              source=None if pick is None else ('ept' if pick['ept'] else 'tile'))
        print(h['slug'], '->', pick and (pick['workunit'], pick['ql'], pick['start'], pick['end'], pick['leafOff'], 'ept' if pick['ept'] else f"tiles {len(pick['tiles'])} {sum((x['bytes'] or 0) for x in pick['tiles'])/1e6:.0f}MB"), f"[{len(units)} units]", flush=True)
        time.sleep(0.3)
    json.dump(out, open(f'{R}/lidar/coverage.json', 'w'), indent=1, sort_keys=True)


if __name__ == '__main__':
    main()
