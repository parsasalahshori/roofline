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
