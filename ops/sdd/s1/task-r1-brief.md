### Task R1 (whole-branch review): hail day boundaries, the final run, merged storms

**Base:** `s1-storm` (all S1 tasks merged). Python in `services/hail` (Python 3.10, GDAL image, Ruling SJ; nothing Python runs locally; CI `Hail` job proves it), plus one DB column and the matching Node filters.

**Findings (confirmed by the S1 review):**
1. **(critical) Yesterday's storms are re-created as today's.** `MESH_Max_1440min` is a rolling 24-hour max. Every non-12Z grid is filed under `convective_day(valid_at)`, so the 13:04Z grid on day D re-inserts all of D-1's swaths as new provisional storms for D, with new ids. Node then alerts and drafts them again with new dedupe keys, and customers get a second text and email about yesterday's hail. (`run.py:32-35`, `source.py:196-208`, `writer.py:89-94`.)
   **Fix:**
   - Build the day's provisional storms from short-window grids: `CONUS/MESH_Max_60min_00.50/<YYYYMMDD>/MRMS_MESH_Max_60min_00.50_<YYYYMMDD-HHMMSS>.grib2.gz` (same bucket, same format).
   - Accumulate them into the convective day's footprint: each new grid's contours are **unioned** into the stored storm geometry and contours (`ST_Union` / shapely `unary_union`), never replacing them.
   - Use the 1440min grid only for the final run of D-1 (see 2), where it replaces the accumulated shapes for that day.
   - Tests:
     - a 13Z grid after a final run creates no D-1 copies;
     - two consecutive 60min grids union, so the area never shrinks;
     - the final 1440min run closes D-1.
   - Record a fixture for the 60min product the same way the 1440min one was captured: a small real file and expected values from an independent reader. If no fixture can be recorded, synthesise one from the existing 1440min fixture by writing a GeoTIFF with GDAL in the test.
2. **(important) The final run happens twice or never.** `final = valid_at.hour == 12` makes both 12Z ticks (about :04 and :34) final for D-1, and the second shifts day-D hail into D-1 as already-final storms. If both 12Z ticks fail, nothing is ever final.
   **Fix:** a run is final when its key is the 1440min grid with `valid_at` exactly at (or the last one at or before) `D@12:00:00Z`, chosen explicitly. Later hour-12 grids are provisional for day D. On each tick, also close any convective day older than D-1 that has no final run, using that day's 12Z 1440min key. Tests for each case.
3. **(important) Merged and split storms leave duplicates.**
   - `match_existing` is strictly one-to-one. When two cells merge, the smaller one is left alive. When a cell splits, the second part gets a new id.
   - `storm_hits` never shrinks, so customers in the overlap belong to two company storms and get two texts.
   **Fix:**
   - Add `storms.merged_into uuid null references storms(id)`:
     - Drizzle schema in `packages/db/src/schema/global.ts`.
     - SQL appended to `packages/db/migrations/0018_storm_grants_rls.sql`: `ALTER TABLE storms ADD COLUMN merged_into uuid REFERENCES storms(id)`, plus `GRANT UPDATE (merged_into) ON storms TO app_hail`.
     - The column added to `packages/db/migrations/meta/0018_snapshot.json`, so `drizzle-kit generate` reports **no changes**. This is Ruling AW: S1 amends its own unreleased custom migration in place.
   - A shape overlapping several existing storms of the same day keeps the **oldest** id, unions their geometry into it, and sets `merged_into` on the others.
   - Shapes overlapping the same existing storm are unioned into it (no split).
   - Node side (only these filters; do not touch plan/settle drafting logic, which Task R2a owns): candidate storms for matching (`packages/db/src/repos/company-storms.ts` / `storm-hits.ts` / `system/storm-match-fanout.ts`) and the storm layer and storms list skip `merged_into is not null`. Add a db test.
   - Python tests for merge and split.
4. **(minor) The worker never alerts while the DB is down.** A connection failure is not a `TickFailed`. Count consecutive failures in process memory as a fallback for the 3-failure ops email (`main.py`, `run.py`).

**Verify:** syntax parse of `services/hail`, Node typecheck, lint, drizzle-kit generate reports no changes; ci-check with `CI_JOBS="Platform E2E Hail"`.
**Commit:** `fix(hail): build the day from short-window MESH and close it once at 12Z; merged storms keep one id`
