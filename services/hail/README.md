# Hail service

Fetches NOAA MRMS `MESH_Max_1440min_00.50` from the public S3 bucket `noaa-mrms-pds` and contours it into the 8 hail
levels 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3 inches. These must equal `HAIL_LEVELS_IN` in `@roofline/shared`.

## Layout

- `hail/source.py`: `HailSource` / `MeshSource`.
- `hail/mesh.py`: list, parse and download MRMS keys.
- `hail/contours.py`: `contour_grid`.
- `hail/storms.py`: groups contours into storm shapes and matches them to existing storms so ids stay stable.
- `hail/writer.py`: transactional writes of runs, storms and contours as the `app_hail` role.
- `hail/run.py`: `tick`, one fetch, contour and write cycle; failures are recorded and raised as `TickFailed`.
- `hail/main.py`: the worker loop at :05 and :35 each hour; one Postmark alert after 3 consecutive failures.
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

## Local database tests

The writer and run tests need a database migrated with `npm run db:migrate`. Set `HAIL_TEST_DATABASE_URL` to the
owner URL, for example `postgres://roofline:roofline@127.0.0.1:54329/roofline`. Without it those tests are skipped.

## Render setup (Ruling SB, owner runbook)

There is no `render.yaml`; do not create one. Create the worker by hand:

1. In Render create a Background Worker with runtime Docker, Dockerfile path `services/hail/Dockerfile` and Docker
   context `services/hail`. Leave the start command empty: the image `CMD` is `python -m hail.main`.
2. Create the `app_hail` login. Run migration 0018 (`npm run db:migrate`), then run `set-role-passwords` in
   `packages/db` with `HAIL_DB_PASSWORD` set (see `ops/sdd/s1/task-1-report.md`). Build the login URL from that
   password.
3. Set the environment variables:
   - `HAIL_DATABASE_URL`: login URL of the `app_hail` role.
   - `OPS_ALERT_EMAIL`: receives the alert and is used as the Postmark From, so it must be a verified Postmark sender.
   - `POSTMARK_SERVER_TOKEN`: Postmark server token.

Behaviour:

- Ticks at :05 and :35 each hour (UTC).
- A 12Z grid closes the previous convective day; its storms become final.
- Three failed ticks in a row send one email. The next success resets the count.
- SIGTERM stops the worker after the current tick.
