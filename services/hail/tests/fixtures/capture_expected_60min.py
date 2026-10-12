# One-off capture of expected-60min.json (not run in CI): eccodes cell-count areas per level for two
# consecutive MESH_Max_60min grids (23Z and 00Z, convective day 2024-05-27) and for their cell-wise max
# ("union"). Usage: python capture_expected_60min.py <first.grib2> <second.grib2>
import eccodes, numpy as np, json, sys
def load(p):
    g=eccodes.codes_grib_new_from_file(open(p,'rb'))
    ni,nj=eccodes.codes_get(g,'Ni'),eccodes.codes_get(g,'Nj')
    assert (ni,nj)==(7000,3500), (ni,nj)
    return eccodes.codes_get_values(g).reshape(3500,7000)
a,b=load(sys.argv[1]),load(sys.argv[2])
lat0,d=54.995,0.01
lats=lat0-d*np.arange(3500)
cell=(d*111.32)*(d*111.32*np.cos(np.radians(lats)))
L=[0.75,1,1.25,1.5,1.75,2,2.5,3]
def areas(v): return {str(l): round(float(((v>=l*25.4)*cell[:,None]).sum()),1) for l in L}
u=np.maximum(a,b)
out={"files":[sys.argv[1].split('/')[-1]+'.gz',sys.argv[2].split('/')[-1]+'.gz'],"cell_area_km2":{"first":areas(a),"second":areas(b),"union":areas(u)},"max_mm":[float(a.max()),float(b.max())]}
json.dump(out,open('expected-60min.json','w'),indent=1); print(json.dumps(out["cell_area_km2"]))
