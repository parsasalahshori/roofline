# Task 3 report: Hail service (storms, writer, Docker, Render docs, CI build step)

## Built
- A-storms-mesh: hail/storms.py (FOOTPRINT_IN, StormShape, split_storms, match_existing), tests; mesh.py downloads to .part and renames on success, raises ValueError for non-.gz keys.
- B-writer: hail/writer.py (writes as app_hail), tests, conftest fixtures conn_factory and clean_db.
- C-run-main-docker: hail/run.py, hail/main.py (Postmark alert via injectable httpx client), Dockerfile (FROM ghcr.io/osgeo/gdal:ubuntu-small-3.8.5), .dockerignore, README Render runbook (Ruling SB, no render.yaml), CI step `docker build -t roofline-hail services/hail` (Ruling SG).

## Reviews
- Review 1: 2 findings. Contact check: F1 amended, F2 approved. Both applied.
- Review 2: 0 findings.

## Minors carried from T2
- mesh.py .part download and .gz key check: done. test_contours nesting tolerance adjusted (one-line change).

## Verify
- Local: python syntax parse ok; git diff --check 1553006 clean. Nothing Python runs on this box; CI proves the rest.

## CI
- Run 38202317362 (7a50f4d): Hail failed, ruff RUF100 on an unneeded `# noqa: DTZ001` in test_contours.py; reverted that file to base (62e8c68).
- Run 38203698198 (62e8c68): ruff clean, 1 pytest failure: test_new_disjoint_cell_gets_new_id built `BASE + FAR` as a list concat, so split_storms saw only the first 0.75 contour. Test now merges per level (453f208).
- Run 38204465906 (453f208): Platform and Hail PASSED.
