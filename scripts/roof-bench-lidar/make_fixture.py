"""Synthetic USGS-style point clouds for the API's hermetic lidar tests (apps/api/test/fixtures/usgs-lidar/).

A 100 m square of UTM 15N (NAD83(2011), EPSG 6344 + NAVD88 heights) holding flat ground (class 2) at 100 m and a
12 x 20 m flat roof (class 6) at 106 m round (560050, 3845050), points on a seeded jitter grid, every pulse a single
return, GPS times in February 2025 (adjusted standard GPS time). Written three ways: LAS 1.4 format 6 LAZ (what 3DEP
QL1 delivers), every 4th point flown in June (house-14-fmt6-june.laz), the first 2000 points as LAS 1.4 format 6 uncompressed, and LAS 1.2 format 1 LAZ (older QL2 projects).
Deterministic: same numpy seed, same bytes. Usage: python -I make_fixture.py <out_dir>
"""
import sys, numpy as np, laspy
from pyproj import CRS

out = sys.argv[1]
rng = np.random.default_rng(7)
E0, N0, STEP = 560000.0, 3845000.0, 0.5   # 4 points per m2
gx, gy = np.meshgrid(np.arange(0, 100, STEP), np.arange(0, 100, STEP))
x = E0 + gx.ravel() + rng.uniform(0, STEP, gx.size)
y = N0 + gy.ravel() + rng.uniform(0, STEP, gy.size)
roof = (np.abs(x - (E0 + 50)) <= 6) & (np.abs(y - (N0 + 50)) <= 10)
z = np.where(roof, 106.0, 100.0) + rng.normal(0, 0.03, x.size)
cls = np.where(roof, 6, 2).astype(np.uint8)
cls[::997] = 7   # a little low noise, which the reader drops
# 2025-02-10 in adjusted standard GPS time (GPS seconds - 1e9).
t = (np.datetime64('2025-02-10T12:00:00') - np.datetime64('1980-01-06T00:00:00')).astype('timedelta64[s]').astype(float) - 1e9 + np.arange(x.size) * 0.001
crs = CRS.from_epsg(6344)


def write(path, version, fmt, compressed, k=slice(None)):
    h = laspy.LasHeader(point_format=fmt, version=version)
    h.scales = [0.01, 0.01, 0.01]
    h.offsets = [E0, N0, 0.0]
    if version == '1.4':
        h.add_crs(crs)
    else:
        h.add_crs(crs, keep_compatibility=True)
    las = laspy.LasData(h)
    las.x, las.y, las.z = x[k], y[k], z[k]
    las.classification = cls[k]
    las.return_number = np.ones(x[k].size, np.uint8)
    las.number_of_returns = np.ones(x[k].size, np.uint8)
    las.gps_time = t[k]
    las.write(path, do_compress=compressed)


write(f'{out}/house-14-fmt6.laz', '1.4', 6, True)
write(f'{out}/house-14-fmt6-head.las', '1.4', 6, False, slice(0, 2000))   # the first 2000 points (one ground strip)
write(f'{out}/house-12-fmt1.laz', '1.2', 1, True)
# The same house flown in June (leaves on): every 4th point, GPS times in 2025-06-15.
t_june = (np.datetime64('2025-06-15T12:00:00') - np.datetime64('1980-01-06T00:00:00')).astype('timedelta64[s]').astype(float) - 1e9 + np.arange(x.size) * 0.001
t = t_june
write(f'{out}/house-14-fmt6-june.laz', '1.4', 6, True, slice(0, None, 4))
print(x.size, int(roof.sum()))
