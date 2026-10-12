# Hail service

Fetches NOAA MRMS `MESH_Max_1440min_00.50` from the public S3 bucket `noaa-mrms-pds` and contours it into the 8 hail
levels 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3 inches. These must equal `HAIL_LEVELS_IN` in `@roofline/shared`.

## Layout

- `hail/source.py`: `HailSource` / `MeshSource`.
- `hail/mesh.py`: list, parse and download MRMS keys.
- `hail/contours.py`: `contour_grid`.
- `hail/units.py`: `MM_PER_IN`, `HAIL_LEVELS_IN`, `convective_day` (12Z to 12Z).

## Running

```
cd services/hail && ruff check . && pytest -q
```

Normally this only runs through the CI `hail` job in the image `ghcr.io/osgeo/gdal:ubuntu-small-3.8.5`. GDAL's
`osgeo` bindings come from the image and are not pip-installed.

## Fixtures (`tests/fixtures`)

- `MRMS_MESH_Max_1440min_00.50_20240528-120000.grib2.gz`: real NOAA file (convective day 2024-05-27), 7000x3500
  lat/lon grid, 0.01 deg, values in mm, -1/-3 missing, 0 = no hail, max 103.4 mm.
- `expected.json`: independent oracle captured with eccodes (not GDAL) by `capture_expected.py`: `cell_area_km2` per
  level by cell count and 25 sample points. `contour_area_km2` is a regression snapshot of contour polygon areas
  captured from the first green CI run.
- `list-20240528.xml`: a recorded S3 ListBucketResult page. Real keys carry an `MRMS_` prefix; `parse_valid_at`
  accepts both forms.

To recapture: `pip install eccodes numpy`, decompress the grib2, run `capture_expected.py`.

## Render setup (Ruling SB, owner step)

There is no `render.yaml`. The hail worker (Task 3) is deployed by the owner as a Render background worker built from
a Dockerfile based on `ghcr.io/osgeo/gdal:ubuntu-small-3.8.5`, with env `HAIL_DATABASE_URL` (the `app_hail` role).
Owner step, to be completed when Task 3 lands.
