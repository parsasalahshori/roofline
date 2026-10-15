"""A synthetic Entwine EPT dataset (Web Mercator, laszip nodes) of the make_fixture.py house, for the API's hermetic
EPT tests: ept.json, ept-hierarchy/0-0-0-0.json (one child as -1, so its own hierarchy file is read too),
ept-hierarchy/1-0-0-0.json and the node LAZ files. Points split between the root (every 4th) and the four depth-1
children by x/y quadrant. Deterministic (seed 7). Usage: python -I make_ept_fixture.py <out_dir>
"""
import json, os, sys, numpy as np, laspy
from pyproj import Transformer

out = sys.argv[1]
rng = np.random.default_rng(7)
E0, N0, STEP = 560000.0, 3845000.0, 0.5
gx, gy = np.meshgrid(np.arange(0, 100, STEP), np.arange(0, 100, STEP))
x = E0 + gx.ravel() + rng.uniform(0, STEP, gx.size)
y = N0 + gy.ravel() + rng.uniform(0, STEP, gy.size)
roof = (np.abs(x - (E0 + 50)) <= 6) & (np.abs(y - (N0 + 50)) <= 10)
z = np.where(roof, 106.0, 100.0) + rng.normal(0, 0.03, x.size)
cls = np.where(roof, 6, 2).astype(np.uint8)
t = (np.datetime64('2017-02-10T12:00:00') - np.datetime64('1980-01-06T00:00:00')).astype('timedelta64[s]').astype(float) - 1e9 + np.arange(x.size) * 0.001
mx, my = Transformer.from_crs(26915, 3857, always_xy=True).transform(x, y)
# A cube round the points, its centre on the roof so the house straddles the depth-1 children.
cx, cy, half = float(np.round(mx.mean())), float(np.round(my.mean())), 128.0
bounds = [cx - half, cy - half, 100 - half, cx + half, cy + half, 100 + half]
os.makedirs(f'{out}/ept-data', exist_ok=True)
os.makedirs(f'{out}/ept-hierarchy', exist_ok=True)
idx = np.arange(x.size)
root = idx % 4 == 0
qx = (mx >= cx).astype(int)
qy = (my >= cy).astype(int)


def node(key, k):
    h = laspy.LasHeader(point_format=1, version='1.2')
    h.scales = [0.01, 0.01, 0.01]
    h.offsets = [cx, cy, 0.0]
    las = laspy.LasData(h)
    las.x, las.y, las.z = mx[k], my[k], z[k]
    las.classification = cls[k]
    las.return_number = np.ones(int(k.sum()), np.uint8)
    las.number_of_returns = np.ones(int(k.sum()), np.uint8)
    las.gps_time = t[k]
    las.write(f'{out}/ept-data/{key}.laz', do_compress=True)
    return int(k.sum())


hier = {'0-0-0-0': node('0-0-0-0', root)}
sub = {}
for X in (0, 1):
    for Y in (0, 1):
        key = f'1-{X}-{Y}-0'
        n = node(key, (~root) & (qx == X) & (qy == Y))
        if key == '1-0-0-0':
            hier[key] = -1
            sub[key] = n
        else:
            hier[key] = n
json.dump(hier, open(f'{out}/ept-hierarchy/0-0-0-0.json', 'w'), indent=1, sort_keys=True)
json.dump(sub, open(f'{out}/ept-hierarchy/1-0-0-0.json', 'w'), indent=1, sort_keys=True)
json.dump({'bounds': bounds, 'dataType': 'laszip', 'hierarchyType': 'json', 'points': int(x.size), 'span': 128,
           'srs': {'authority': 'EPSG', 'horizontal': '3857', 'vertical': '5703'}, 'version': '1.0.0'},
          open(f'{out}/ept.json', 'w'), indent=1, sort_keys=True)
print(hier, sub)
