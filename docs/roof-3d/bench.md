# Design note: the benchmark (track `bench`)

## Problem

The roof reconstruction (`packages/shared/src/roof-reconstruct/`) has been tuned in rounds, each judged by a Python
scorer (`ev_score.py`) and the checker script, run by hand on whichever houses were at hand. That cannot tell a
change that helps from one that moves error from one kind of house to another, and it had nothing for the failure the
owner saw twice: foliage over the roof edge gives sliver faces, chamfered corners and a jagged outline (305 Ridgeway
Dr, Little Rock), and a roof hidden under a canopy gets a clean rectangle that nothing marks as unverified. Specific
gaps:

- the Python venv the scorer needed is gone, and the repository had no scorer of its own;
- no cohorts: nothing could say "better on trees, worse on steep roofs";
- no held-out houses, so tuning on the 54 houses was also testing on them;
- no tree-heavy houses to speak of (the 54 were picked for size and pitch);
- no determinism, seed or runtime check, and no rule that stops a change from making things worse.

## Approach

One command, `npm run roof3d:bench -w @roofline/api`, reads only files and runs the reconstruction the way the
server does it (`roofOnLayers`, then the Google check; its only change is an optional `seed`, which the server never
sets). See [benchmark.md](benchmark.md) for the metrics and how to use it. Decisions:

- **TypeScript port of the scorer.** No Python in the repository. The port was cross-checked against `ev_score.py`
  on the 34 EagleView houses (same face counts and main pitches; IoU, area error and line totals within the Python
  output's own rounding). It adds outline IoU, boundary distances, sliver/steep/rectilinearity counts, review-flag
  precision and recall, determinism and runtime.
- **Polygon clipping from `polygon-clipping`** (MIT, dev dependency of `@roofline/api`), with an independent grid
  estimate as the fallback when it throws and as the oracle in a property test.
- **Cohorts from the data, frozen in a manifest.** The canopy tag is measured on Google's own photo, height map and
  mask, not on the reconstruction, so it cannot move when the code under test does. The split is
  `sha1(slug) mod 10 < 3`, a pure function of the name, checked against the manifest on every run.
- **Truth is never invented.** EagleView houses are `eagleview`; every other house gets labelled proxies, and the
  report keeps them apart. A `visual` grade (hand-drawn outline) is supported but unused (see below).
- **Gates are data** (`gates.json`), judged cohort by cohort on the mean over seeds 7, 8 and 9. Runtime is compared
  after dividing by a calibration loop timed in the same run, so a loaded machine does not fail a gate. Calibrated
  with an A/A test: the strict gates failed 17 times on the same code at other seeds, so a number may move by the
  larger of its limit and the baseline's own seed range, and cohorts under 10 houses are reported, not gated.
- **Tree houses without spending more than budgeted.** Candidates are found from free public sources (OpenStreetMap
  outlines, USGS NAIP imagery), so the paid requests go to houses that probably have trees. A ledger that survives
  runs caps Data Layers at 40 requests; nothing is bought without `--go`.
- **Own vitest project** (`apps/api/vitest.bench.config.ts`, `npm run test:bench -w @roofline/api`). The API's own
  project starts a Postgres Testcontainer for every file; the benchmark's tests need none.

## Alternatives rejected

- *Keep the Python scorer and recreate the venv.* It would break again the same way, and a second language for
  something every change must run is a tax on every reviewer.
- *Tag trees from the reconstruction's own `treeShare`.* Then a change to the tree test would change the cohort the
  change is judged on.
- *Gate on proxies.* Google's mask is itself wrong under trees; a fix that improves the outline can lower the
  mask IoU. Proxies are reported, not gated; tree houses are gated on counts that need no truth (slivers, thin faces,
  steep junk, failures, checker passes, determinism, runtime).
- *Seed-stable means byte-identical.* Nearly every house differs in the last decimals between seeds; the report
  says "materially different" (a count, a verdict, area over 1 %, overlap over 0.005) and keeps the strict test as a
  separate field.
- *Hand-label tree-house outlines on the Pulaski County leaf-off orthophoto.* Looked at crops of 305 Ridgeway Dr and
  909 E H Ave: the roofs are partly in tree shadow, the photo is not true ortho (up to about 0.8 m of lean), and
  placing corners to 0.3 m from a rendered grid in the dark parts is not something I can do reliably. A truth that
  is wrong by more than the errors being measured is worse than none, so none was added. The harness takes a
  `visual.json` if a person draws one.

## Risks

- The canopy thresholds are not natural gaps in the data (rim share runs continuously from 0 to 0.8). They are
  stated, justified, and their sensitivity is reported: a 20 % change in any of them moves 1 to 8 of the 54 dev houses
  to another class. Treat per-cohort medians as indications, and use the gates for direction only.
- Cohort medians over small cohorts are noisy. Gates skip truth rules below 3 comparable houses; the held-out split
  hides cohorts under 5.
- The held-out split is small (about 30 % of the houses), and the first 54 houses were not chosen blind. It is a
  guard against tuning to the dev houses, not a clean estimate of field accuracy.
- The 54 original houses have no recorded download date; their delete-by date is the earliest plausible one.
- NAIP and OpenStreetMap are used as pre-screens only. NAIP predicts crown cover over the roof worse than Google's
  own photo does, so some bought "tree" houses turn out light or none by the benchmark's own definition.
- A baseline is tied to the manifest. Adding houses means freezing a new baseline, which resets what "worse" means.

## Rollback

Everything is additive: `apps/api/src/bench/`, four scripts, a vitest project and `docs/roof-3d/`. The reconstruction
code changed in one place (an optional `seed` on `roofOnLayers`, default behaviour identical, verified: at the
pristine 5cabb413 the old checker and the benchmark give the same faces, areas, reasons and checker verdicts on all
54 houses). Reverting the commits removes the benchmark and leaves the server as it was. The `polygon-clipping`
dev dependency goes with them.
