# PROGRESS
goal: Make the Roofline / WinChoice web app work end to end (every journey a user can start can be finished,
      on the built app, with no dead ends or errors), and make the roof measurement clearly more accurate
      against the EagleView answer keys. Base: real-lookups 8beba4fb (2026-11-21).
scope: web app + API + worker. The iPhone app is out of this run (audited and fixed Nov 14; TestFlight is blocked
       on Apple's agreement). No redesign (owner approval rule). No hardening/policy work (owner: it is a demo).
green:
  - npm run typecheck && npm run lint: clean
  - npm run build -w @roofline/web (includes check-build-preload)
  - vitest shared / web / api / db: 0 failures except the 3 known (front-desk stats 'today' x2, approvals EPIPE), or those fixed
  - e2e: `npm run e2e` on the integrated branch: every spec passes, including the new per-area journey specs
    (each new spec was seen failing before its fix, or covers a journey that had no spec)
  - one walk of the integrated demo (WinChoice + Summit Ridge) in a real browser: every journey in `journeys` below finishes
  - roof bench (dev + held-out, EagleView truth, re-fetched Google data):
      all gates in ~/RooflineWork/roof-bench/gates-v3.json pass against a fresh baseline of head (algorithm 6), and
      the metric below improves on dev AND held-out
metric:
  - app: open P0/P1 findings across the five areas (target 0)
  - roof: median absolute error vs EagleView for ridge, hip, valley, eave, rake totals and for area, plus main-pitch
    hit rate. Target: every line type's median error at least a third lower than the fresh baseline, area and pitch
    no worse. (Baseline numbers go in `roof log` once the benchmark data is re-fetched.)
fence: worktrees ~/RooflineWork/wt-b-* (swarm), wt-roof-better (roof), wt-better (integration). ~/roofline-demo
       (real-lookups) is touched only by the final fast-forward merge, and only with the owner's OK (commit = push).
never: no attribution lines in commits; no force-push; no data deletion; no paid data (Google only inside its free
       monthly quota); no new accounts; keys never printed; Sonnet agents xhigh at most; no DB migrations from swarm
       agents (a fix that needs one is listed for the orchestrator); no push, deploy or TestFlight without the owner's OK.
budget: 5 area agents (Sonnet, high), one pass each: walk -> fix P0/P1 -> journey spec. One full suite at the end.

## swarm (area -> worktree / branch / ports)
| area | worktree | branch | demo port / db port | e2e port |
|------|----------|--------|---------------------|----------|
| crm-core | wt-b-crm | b/crm | 4721 / 54721 | 4731 |
| estimator-flow (UI, proposals, homeowner page; not the roof engine) | wt-b-estimator | b/estimator-flow | 4722 / 54722 | 4732 |
| windows-quote (window measure, /q/:slug, scans, homeowner API) | wt-b-windows | b/windows-quote | 4723 / 54723 | 4733 |
| backoffice (WinChoice designer, products, orders, PDFs) | wt-b-backoffice | b/backoffice | 4724 / 54724 | 4734 |
| ops-ai (storm, front desk, agents, approvals, claims, demo sims) | wt-b-ops | b/ops-ai | 4725 / 54725 | 4735 |
| roof engine (orchestrator, alone) | wt-roof-better | roof/better | - | - |

## journeys (the end-to-end walk at the end)
1. Sign up -> setup checklist -> invite a teammate -> sign in as them.
2. New lead (public quote page /q/:slug) -> appears in the CRM -> customer + job.
3. Measure a roof from an address -> sections/lines -> proposal -> homeowner page -> e-sign -> signed PDF -> job moves.
4. Measure windows -> order -> back-office design -> factory order PDF -> stage moves -> customer status updates.
5. Storm hits (demo sim) -> storm plan -> approve -> door route.
6. Call/text comes in (demo sim) -> front desk conversation -> appointment on the calendar.
7. Agents dashboard: a waiting task -> approve -> it shows in the feed.

## findings (P0/P1; every one fixed has a test that failed before, or is a new journey spec)
| id | sev | area | finding | status |
|----|-----|------|---------|--------|
| C1 | P0 | crm | Pick this plan / Add a card opened an unreachable checkout page; texting setup was blocked behind it | fixed |
| C2 | P1 | crm | New inspection as office: person defaulted to someone who cannot take one, times never loaded | fixed |
| C3 | P1 | crm | Customers Tag and Texting filters only covered the first 50 rows | fixed (server-side) |
| C4 | P1 | crm | Jobs "open" count included installed jobs | fixed |
| C5 | P1 | crm | A missing appointment offered Try again instead of Not found | fixed |
| E1 | P1 | estimator | A taken or invalid phone on a new customer said only "Please check this field" | fixed |
| E2 | P1 | estimator | An exact report's card showed outline numbers (42.8 sq) while the proposal used the report (26.1 sq) | fixed |
| E3 | P1 | estimator | Ordering an exact report on a home with no customer came back to no proposal | fixed |
| E4 | P1 | estimator | A rep typing a new address was told to pick a customer with no way to | fixed (link to add one) |
| E5 | P1 | estimator | estimator.spec and phone.spec still expected the removed Roof/Windows/Gutters switch | fixed (specs) |
| E6 | P1 | roof | Hip caps were never priced on a free estimate (ridge only) | fixed (roof-model capFt) |
| B1 | P0 | backoffice | No way to approve a discount | fixed |
| B2 | P0 | backoffice | No Accept in the quote editor; the Status control's "Accepted" was refused by the server | fixed |
| B3 | P1 | backoffice | An accepted order without a measuring sheet said "Not released to the factory yet" | fixed |
| B4 | P1 | backoffice | New quote never offered importing measured windows | fixed |
| B5 | P0 | backoffice | Saving a house photo in the visualizer failed (400) | fixed |
| B6-B9 | P1 | backoffice | Dead "Try again" after a failed autosave; accepted quote still editable; editor cut off at 375 px; factory PDF silent on safety glass | fixed |
| O1 | P1 | ops | Front Desk average answer time counted unanswered calls as 0 ms (the long-failing 'today' tests) | fixed |
| O2 | P1 | ops | approvals EPIPE test | fixed (test keeps the connection alive) |
| O3-O7 | P0/P1 | ops | Demo call "booked" a visit nobody was assigned to (never on the calendar); storm sim drafted no plan; no booking card; plan card said 1,500 doors for 75 homes | fixed |
| I1 | P1 | integration | A window company's job "New quote" opened a roof shingle quote | fixed (opens the back office for that job) |
| I2 | P2 | integration | Approval bar said "ad spend" on an exact roof report | fixed |
| W | - | windows | No P0/P1 found; journey spec added | - |

Open P2 (not fixed, listed by the agents): proposal text preview shows {address} unfilled (needs a payload field); calendar week
view hides person-less visits; storm/front-desk demo scripts talk roofs for WinChoice; /storm/settings and /storm/ads say "could
not find that storm"; homeowner window rows named "Window 2" not by room; card-measured windows open in the sheet method;
company phone shown raw after save; global search Enter picks an action before a match; times in two zones on the proposal page.

## paths (roof)
| path | idea | metric vs baseline | keep/kill | evidence |
|------|------|--------------------|-----------|----------|
| R1 | creases labelled by drainage: upper face draining onto a lower one along a near-level line = eave; same-way same-pitch = pitch break; opposite faces = ridge | dev ridge 28->19, valley 42->24, eave 24->19, hip 15->22, rake 26->26; held-out ridge 19->12, eave 22->12, valley 23->23, hip 42->42, rake 17->17 | KEEP (algorithm 7) | roof/better 44d2ba8a; run-v7.json; all gates pass |
| R2 | snap face pitches to the roof's dominant whole pitches | main pitch exact 14->12 of 18, 7->6 of 14 | kill | pitchsnap.py |
| R3 | eave vs rake read off the height map along the edge | eave 19->35, rake 26->32 (dev) | kill | xform_rake.py |
| R4 | dissolve narrow same-way strips and flat pockets | dev 21.9->22.0, held-out 20.9->23.0 (mean of medians); halves one simple house, hurts complex ones | kill | dump-v3* |
| R5 | pitch break whatever the line's direction | dev 21.9->22.8, held-out 20.9->21.4 | kill | dump-v4, v5 |
| R6 | eaveDeg 50-60 | eave better, rake worse by as much | kill | dump-v2-e* |
converged: R1 is best; five further paths failed to beat it. What is left needs more than the height map (docs/roof-3d/line-kinds.md).

## roof log (EXPECTED vs SAW)
- Benchmark Google data re-bought 2026-11-21 (84 houses, free quota; ~/RooflineWork/roof-bench/refetch-2026-11-21; delete-by 2026-12-21).
- Fresh baseline of head (algorithm 6): ~/RooflineWork/roof-bench/better/baseline-head.{json,txt}.
  Median |error| vs EagleView, dev (18 houses) / held-out (14):
    area 4.0% / 2.4%; main pitch exact 14/18, 7/14; within 1/12: 16/18, 13/14
    ridge 28 / 19, hip 15 / 42, valley 42 / 23, eave 24 / 22, rake 26 / 17 (percent)
- Tools (outside the repo, ~/RooflineWork/roof-bench/better/): linescore.py, linescore_dump.py (official totals), evtruth.py (per-line
  answer key from EagleView's 3D faces, agrees with official totals within ~8% a house), edgematch.py (which of our lines sit on
  which EagleView lines, by kind), render.py (pictures), whatif.py (relabel experiments without the engine).
- Finding: 85-90% of EagleView's line length has a line of ours within 0.75 m; the kind is often wrong.

## log
- 2026-11-21: run started. Worktrees made, deps installed.
- Baseline e2e on head (watched failing): 142 passed, 2 failed: estimator.spec "the Measure head ... Roof | Windows | Gutters switch",
  phone.spec "the proposal view fits the phone" (log ~/RooflineWork/logs/better/e2e-baseline.log).
- An agent's broad `pkill` stopped the owner's 4500/4600 apps twice; restarted both (4600 with its AI env) and told every agent to kill by its own PID only.
- All five area agents done; branches b/crm d929ad3e, b/estimator-flow 46dd5c79, b/windows-quote 4e968914, b/backoffice ddb2f128, b/ops-ai 11302ad4.
- Merged with roof/better into better/integration (no conflicts). typecheck + lint clean. Integration fixes 1730f1c8.
- e2e on the merged branch: 151 passed, 0 failed (was 142 + 2 failing); includes the five new journey specs.
- Walk of the merged app with real keys (port 4680, own database): two real roofs measured in 3D with the new line kinds and
  ridge + hip cap priced, 0 console/5xx errors; WinChoice job -> New quote -> back-office quote editor.

## round 1 closed (2026-11-21 11:40)
- Owner said go: real-lookups fast-forwarded to e1e06dea and pushed; 4500 (~/roofline-demo) and 4600 (~/roofline-try, AI env)
  restarted on it, sign-in checked on both. Online redeploy (Render + Vercel) HELD on the owner's "wait": it goes out
  once, after roof round 2.

# ROOF ROUND 2 (2026-11-21, owner: "I need the measurement accuracies to increase... deploy a lot of Fable 5.2 agents")
goal: clearly lower roof line, pitch and area error against the EagleView answer keys than algorithm 7.
green:
  - `npm run roof3d:bench ... --compare ~/RooflineWork/roof-bench/better/baseline-v7.json --gates gates-v3.json`: all gates pass
  - scorer `~/RooflineWork/roof-bench/better/score.sh <worktree> <run> --split all`: OBJECTIVE (mean of the five line
    medians) lower than 21.9 (dev) and 20.9 (held-out); area (4.0 / 2.4 %) and main pitch exact (14/18, 7/14) not worse
  - the per-line table (`--edges`): same-kind shares up, missing and extra shares not up
  - the same on the FRESH answer keys the data agent adds (nobody tunes on them)
  - an independent reviewer's read of the merged change (earlier rounds: it caught what the benchmark could not)
  - shared roof tests + roof-bench tests pass
metric: OBJECTIVE dev / held-out / fresh; main pitch exact; area median error
fence: worktrees ~/RooflineWork/wt-r-* (branches roof2/*), integration in wt-roof2 (roof2/integration). No push until the owner's OK.
never: as round 1, plus: tune on dev only; no house-specific rules; every change behind a parameter; no paid data.
budget: 7 Fable agents in parallel (6 tracks + data), then integration by the orchestrator, one reviewer, one remediation pass.
brief: ~/RooflineWork/plans/roof2-brief.md

## roof2 tracks
| track | worktree / branch | idea | result |
|-------|-------------------|------|--------|
| dormers | wt-r-dormers / roof2/dormers | small faces from the height map (bumps on a face, finer plane pass, hip ends) | DONE cbfd8de7 (partial): plane search to 80 planes + thin guard; dev OBJECTIVE 21.9->21.2, held-out same (no held-out house reaches 40 planes); gates pass. KEY FINDING: with every dissolve rule off + 80 planes dev OBJECTIVE is 18.8 and missing shares halve, but 19 gates fail (the thin-face gate counts real dormer faces as junk; EagleView's own faces are thin 121 of 389 times). Decision for the orchestrator: re-base the thin gate on complex roofs. Also: a loop in buildFaces (splitNecks vs explained) on 4 houses |
| photo | wt-r-photo / roof2/photo-faces | straight photo edges as evidence for creases inside the roof | running |
| walls | wt-r-walls / roof2/walls | steps typed piece by piece: upper eave/rake + flashing, not a valley | running |
| primitives | wt-r-primitives / roof2/primitives | fitted gable/hip shapes for simple wings the plane search cut into strips | running |
| pitch | wt-r-pitch / roof2/pitch | plane fit, scale check, pooling between faces, calibration | DONE b1e17e34 (win): pooling (pitch.pool) + Google calibration 0.25/12 (pitch.offsetX12); main pitch exact 14->15/18 dev, 7->8/14 held-out; faces within 0.5/12: 56->73 % dev, 58->67 % held-out; area and lines unchanged; gates pass. Dead ends: other plane fits, Google segments, global scale, per-house tilt |
| labels | wt-r-labels / roof2/labels | line kinds learned from the per-line answer key, written back as rules | running |
| data | wt-r-data / roof2/data | more EagleView sandbox answer keys as a sealed fresh set | DONE 3c91f4ce: 20 new keys in testset-ev2 (7 fresh, 6 fresh-derived, 7 fresh-medium; manifest-ev2.json); score with work-data/score_ev2.sh; baseline alg 7 on high (13): OBJECTIVE 26.5, area 6.1 %, pitch exact 10/13; SEALED (tracks never see it); delete by 2026-12-21 |

## next
- wait for the seven reports; merge winners into roof2/integration one at a time behind the gates, measuring combinations
  through ROOF3D_TUNING; reviewer; remediation; bump the algorithm version once; then ask the owner to merge + deploy.

## status
state: running (roof round 2; agents in flight)
needs-me: nothing now
