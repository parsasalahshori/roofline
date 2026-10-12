# One-off capture of expected.json (not run in CI). Independent of GDAL: reads the GRIB2 with eccodes
# (pip install eccodes numpy) and counts 0.01-degree cells >= each level (cell_area_km2), then samples
# interior points (5x5 neighbourhood all >= level) and far-outside points (11x11 all < 0.75 in).
# Usage: python capture_expected.py <decompressed .grib2>
import eccodes, numpy as np, json, sys
g=eccodes.codes_grib_new_from_file(open(sys.argv[1],'rb'))
v=eccodes.codes_get_values(g).reshape(3500,7000)
lat0, lon0, d = 54.995, 230.005-360, 0.01
lats = lat0 - d*np.arange(3500)
cell_km2 = (d*111.32)*(d*111.32*np.cos(np.radians(lats)))  # per row
LEVELS=[0.75,1,1.25,1.5,1.75,2,2.5,3]
out={"source_key":"CONUS/MESH_Max_1440min_00.50/20240528/MRMS_MESH_Max_1440min_00.50_20240528-120000.grib2.gz",
 "valid_at":"2024-05-28T12:00:00Z","convective_day":"2024-05-27",
 "grid":{"ni":7000,"nj":3500,"first_lat":54.995,"first_lon_0_360":230.005,"step_deg":0.01,"missing":[-1,-3],"units":"mm"},
 "cell_area_km2":{}, "max_mm": float(v.max()), "points":[]}
rng=np.random.default_rng(7)
for L in LEVELS:
    m = v >= L*25.4
    out["cell_area_km2"][str(L)] = round(float((m*cell_km2[:,None]).sum()),1)
    # interior: 5x5 neighbourhood all >= level
    k=2; mi=m.copy()
    for di in range(-k,k+1):
        for dj in range(-k,k+1):
            mi &= np.roll(np.roll(m,di,0),dj,1)
    ii,jj=np.nonzero(mi)
    if len(ii):
        for idx in rng.choice(len(ii), size=min(3,len(ii)), replace=False):
            i,j=ii[idx],jj[idx]
            out["points"].append({"lat":round(lat0-d*i,4),"lon":round(lon0+d*j,4),"level_in":L,"inside":True,"cell_mm":float(v[i,j])})
# outside points: 11x11 neighbourhood all < 0.75in but within the bbox of hail
m=v>=19.05
far=~m
for di in range(-5,6):
    for dj in range(-5,6):
        far &= ~np.roll(np.roll(m,di,0),dj,1)
ii,jj=np.nonzero(m); i0,i1,j0,j1=ii.min(),ii.max(),jj.min(),jj.max()
sub=np.zeros_like(far); sub[i0:i1,j0:j1]=True
ii,jj=np.nonzero(far&sub)
for idx in rng.choice(len(ii), size=4, replace=False):
    i,j=ii[idx],jj[idx]
    out["points"].append({"lat":round(lat0-d*i,4),"lon":round(lon0+d*j,4),"level_in":0.75,"inside":False,"cell_mm":float(v[i,j])})
json.dump(out, open('expected.json','w'), indent=1)
print(json.dumps(out["cell_area_km2"]), out["max_mm"], len(out["points"]))
