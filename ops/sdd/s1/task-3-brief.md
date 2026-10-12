### Task 3: Hail service — storms, writer, Docker, Render, CI

**Base:** `s1-storm` after Task 2 is merged. From T2: `HailSource`, `HailGrid`, `MeshSource`, `contour_grid`, `Contour`, `convective_day`. From T1: the global tables and the `app_hail` role. Real CI: `.github/workflows/ci.yml` has jobs `platform`, `v1`, `e2e`; migrations run with `npm run db:migrate` (`DATABASE_URL_OWNER`, default `postgres://roofline:roofline@127.0.0.1:54329/roofline`); local DB image `postgis/postgis:16-3.4`. There is **no** `render.yaml` in the repo (Ruling SB).

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 `storms.py` (grouping and stable ids); Builder 2 `writer.py` + `run.py` + `main.py`; Builder 3 `Dockerfile`, the CI build step (Ruling SG), the Render setup in README (Ruling SB).

**Files:** Create `services/hail/hail/{storms,writer,run,main}.py`, `services/hail/Dockerfile`, `services/hail/tests/{test_storms,test_writer}.py`; Modify `.github/workflows/ci.yml` (append the `docker build` step to T2's `hail` job — Ruling SG), `services/hail/README.md` (Render worker setup — Ruling SB; no `render.yaml`).

**Interfaces:**
```python
# storms.py
class StormShape(NamedTuple): footprint: MultiPolygon; contours: dict[float, MultiPolygon]; max_in: float
def split_storms(contours: list[Contour]) -> list[StormShape]       # connected components of the 0.75 level; higher levels clipped to each
def match_existing(shapes, existing: list[tuple[UUID, MultiPolygon]]) -> list[tuple[UUID | None, StormShape]]
    # a shape overlapping one existing storm of the same convective day keeps its id; overlapping two → the larger overlap wins, the other is left (never merged in S1, Ruling 3); none → None (new)
# writer.py
def write_run(conn, grid: HailGrid, day: date, matched, final: bool) -> RunSummary   # one transaction; insert hail_runs; upsert storms (status final when final=True, last_grew_at when area grew > 1%); replace storm_contours
def record_failure(conn, key: str, err: Exception) -> int          # returns consecutive failure count
# run.py
def tick(source: HailSource, conn_factory, now: datetime) -> RunSummary | None
    # final = the grid's valid_at hour is 12Z (closes the day before)
# main.py — loop: tick at :05 and :35; on 3 consecutive failures email OPS_ALERT_EMAIL through Postmark's API (plain fetch via httpx); SIGTERM-safe
```

**Tests:**
- two consecutive fixture runs keep storm ids; a new disjoint cell gets a new id; the 12Z run sets `final`; writer against PostGIS (CI service) writes rows readable by `app_tenant`; failure counter resets on success.

**Carries and rulings:**
- **Ruling SB:** no root `render.yaml` exists; do not create one. Document the Render background worker (Docker, `services/hail/Dockerfile`, env `HAIL_DATABASE_URL`, `OPS_ALERT_EMAIL`, `POSTMARK_SERVER_TOKEN`) in `services/hail/README.md` as an owner setup step.
- **Ruling SC/SG:** the `hail` CI job is added by **Task 2** (its tests need it first); this task appends only the image build step to that job: `- run: docker build -t roofline-hail services/hail`, and the writer tests that use `HAIL_TEST_DATABASE_URL` (see the T2 brief for the full job).
- **Python (no local runs on the build box):** in `services/hail`, `ruff check .` and `pytest -q`; CI runs them in the `hail` job (Ruling SC) — prove with `CI_JOBS="Platform Hail" ops/bin/ci-check`.

**Verify notes:**
- CI `hail` job; `docker build services/hail` in CI only.
- Commit: `feat(hail): group hail into storms, write them as app_hail, and run every 30 minutes on Render`
