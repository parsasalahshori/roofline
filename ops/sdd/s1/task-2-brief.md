### Task 2: Hail service — MESH fetch and contours

**Base:** `s1-storm` after Task 1 is merged (for the shared `HAIL_LEVELS_IN` the units test reads). New tree `services/hail/` (nothing exists yet). No Node code.

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 `source.py` (`HailSource` protocol, `MeshSource`) + `mesh.py` (list/download/decompress); Builder 2 `contours.py` + `units.py`; Builder 3 `pyproject.toml`, fixture capture script note, `tests/test_{mesh,contours}.py`.

**Files:** Modify `.github/workflows/ci.yml` (the `hail` job, Ruling SG); Create `services/hail/{pyproject.toml,README.md}`, `services/hail/hail/{__init__,source,mesh,contours,units}.py`, `services/hail/tests/{conftest,test_mesh,test_contours}.py`, `services/hail/tests/fixtures/` (one real MESH_Max_1440min file from a known past storm, ≤ 2 MB gz, plus `expected.json` with areas per level — captured by the lead once, documented in README).

**Interfaces:**
```python
# source.py
class HailGrid(NamedTuple): valid_at: datetime; key: str; path: Path   # decompressed GRIB2 on disk
class HailSource(Protocol):
    name: str
    def latest(self, after_key: str | None) -> HailGrid | None: ...   # None = nothing new
class MeshSource:  # https://noaa-mrms-pds.s3.amazonaws.com/?list-type=2&prefix=CONUS/MESH_Max_1440min_00.50/<YYYYMMDD>/
    def __init__(self, http: httpx.Client, workdir: Path, base_url: str = "https://noaa-mrms-pds.s3.amazonaws.com"): ...
# mesh.py
def list_keys(http, base_url, day: date) -> list[str]            # sorted, parses the ListBucketResult XML
def parse_valid_at(key: str) -> datetime                         # MESH_Max_1440min_00.50_YYYYMMDD-HHMMSS.grib2.gz → UTC
def download(http, base_url, key, workdir) -> Path               # streams, gunzips, returns .grib2 path
# contours.py
class Contour(NamedTuple): threshold_in: float; geom: shapely.MultiPolygon   # EPSG:4326
def contour_grid(path: Path, levels_in=HAIL_LEVELS_IN, simplify_m=30, min_area_km2=0.1) -> list[Contour]
# units.py
MM_PER_IN = 25.4 ; HAIL_LEVELS_IN = (0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0)   # must equal @roofline/shared HAIL_LEVELS_IN (a test reads shared/src/storm.ts)
def convective_day(t: datetime) -> date                           # 12Z–12Z: t < 12:00Z → previous day
```
- `contour_grid`: open with GDAL, treat ≤ 0 and the product's missing values (-1, -3) as nodata, levels in mm (`level_in * 25.4`), `gdal.ContourGenerateEx` with `FIXED_LEVELS` and `POLYGONIZE=YES`, reproject nothing (MRMS grids are lat/lon), simplify in a local equal-area projection (EPSG:5070) then back; each level's polygon is "≥ level" (union of higher bands).

**Tests:**
- `parse_valid_at`/`convective_day` boundaries (11:59Z, 12:00Z); `list_keys` with a recorded XML; the fixture's per-level areas within 2% of `expected.json`; nested levels (each higher level within the lower one); a point list inside/outside per `expected.json`; levels match the shared constant.

**Carries and rulings:**
- Python only. Package layout: `services/hail/pyproject.toml` with `[project.optional-dependencies] dev = ["pytest", "ruff"]`, runtime `psycopg[binary]>=3.2`, `shapely>=2`, `httpx`; GDAL comes from the image's `osgeo` bindings (not pip).
- **Ruling SC — the `ci.yml` addition** (Ruling SG: this task adds the job because its pytest suite needs it; T3 appends one build step; no other S1 task edits `ci.yml`):
```yaml
  hail:
    name: Hail service (ruff, pytest)
    runs-on: ubuntu-latest
    timeout-minutes: 30
    services:
      db:
        image: postgis/postgis:16-3.4
        env: { POSTGRES_USER: roofline, POSTGRES_PASSWORD: roofline, POSTGRES_DB: roofline }
        ports: ['54329:5432']
        options: >-
          --health-cmd "pg_isready -U roofline -d roofline" --health-interval 2s --health-retries 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run db:migrate          # DATABASE_URL_OWNER defaults to 127.0.0.1:54329
      - run: >-
          docker run --rm --network host -v "$PWD:/w" -w /w/services/hail
          -e HAIL_TEST_DATABASE_URL=postgres://roofline:roofline@127.0.0.1:54329/roofline
          ghcr.io/osgeo/gdal:ubuntu-small-3.8.5
          bash -c "apt-get update -qq && apt-get install -y -qq python3-venv >/dev/null &&
          python3 -m venv --system-site-packages /tmp/v && /tmp/v/bin/pip install -q -e '.[dev]' &&
          /tmp/v/bin/ruff check . && /tmp/v/bin/pytest -q"
```
  `conftest.py` connects as the owner (`HAIL_TEST_DATABASE_URL`), sets `ALTER ROLE app_hail LOGIN PASSWORD 'test'`, and runs the writer as `app_hail`; tests needing the DB skip when the variable is unset.
- **Python (no local runs on the build box):** in `services/hail`, `ruff check .` and `pytest -q`; CI runs them in the `hail` job (Ruling SC) — prove with `CI_JOBS="Platform Hail" ops/bin/ci-check`.

**Verify notes:**
- CI `hail` job only (`ruff check`, `pytest`).
- Commit: `feat(hail): fetch NOAA MRMS MESH and contour it into hail levels`
