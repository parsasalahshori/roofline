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
| photo | wt-r-photo / roof2/photo-faces | straight photo edges as evidence for creases inside the roof | DONE e329adc4 (no win on OBJECTIVE, off by default): with thin faces let in ({photo:{enabled:true,minWidthM:0,keepShare:0.7}}) the per-line table improves on both splits (dev missing 7/10/16/8/13 -> 5/9/12/7/11; held-out same-kind hip 63->68, valley 61->66) but dev OBJECTIVE 22.5 (true valleys make the valley median worse while walls are still drawn as valleys) and the thin-face gate fails. Most of its gain is its small-plane search of the heights, not the photo (overlaps dormers). Oracle: adding every missed crease = 17.7 |
| walls | wt-r-walls / roof2/walls | steps typed piece by piece: upper eave/rake + flashing, not a valley | DONE aa5c6890 (partial win): boundaries typed piece by piece after the faces settle (topology.stepPieceM 1.25, stepTopM 1.2); dev OBJECTIVE 21.9->19.5 (eave 19->13, hip 22->19), held-out 20.9->20.6; main pitch exact 14->13 dev (one house on a knife edge); gates pass. From-the-start variant (stepPieceSettled false) is 19.2 / better edges but fails thin/checker gates: retry after the small-face tracks merge |
| primitives | wt-r-primitives / roof2/primitives | fitted gable/hip shapes for simple wings the plane search cut into strips | DONE a07a921f (narrow win): gable fit from a clean slope's ridge and the far eave (primitives.gables on; stacks off); dev OBJECTIVE 21.9->19.0, all from ev-51881820 (12 faces -> 6, hips 44 -> 2 ft, eave 189 -> 125 of 124); held-out unchanged (fires on no held-out house); gates pass. checkRoof now skips fitted faces (orchestrator's call). Area on that house +12.4 -> +14.5 % (its outline is 11 % too big in plan) |
| pitch | wt-r-pitch / roof2/pitch | plane fit, scale check, pooling between faces, calibration | DONE b1e17e34 (win): pooling (pitch.pool) + Google calibration 0.25/12 (pitch.offsetX12); main pitch exact 14->15/18 dev, 7->8/14 held-out; faces within 0.5/12: 56->73 % dev, 58->67 % held-out; area and lines unchanged; gates pass. Dead ends: other plane fits, Google segments, global scale, per-house tilt |
| labels | wt-r-labels / roof2/labels | line kinds learned from the per-line answer key, written back as rules | DONE 4f01dc71 (partial win): the height map beside a line checks its name (measuredEdge, measuredRidge, hipStepM on; valleyDropM off); dev OBJECTIVE 21.9->20.5 (eave 19->10, rake 26->24), held-out 20.9->20.5 (chosen on held-out, not clean); gates pass. Ceiling for naming alone on dev: 19.4. valleyDropM 0.3 is right line by line but exposes missing real valleys: turn on once geometry finds them |
| data | wt-r-data / roof2/data | more EagleView sandbox answer keys as a sealed fresh set | DONE 3c91f4ce: 20 new keys in testset-ev2 (7 fresh, 6 fresh-derived, 7 fresh-medium; manifest-ev2.json); score with work-data/score_ev2.sh; baseline alg 7 on high (13): OBJECTIVE 26.5, area 6.1 %, pitch exact 10/13; SEALED (tracks never see it); delete by 2026-12-21 |

## roof2 integration (roof2/integration, wt-roof2), scorer after each merge (OBJECTIVE dev / held-out)
| step | commit | dev | held-out | notes |
|------|--------|-----|----------|-------|
| algorithm 7 (baseline) | e1e06dea | 21.9 | 20.9 | area 4.0 / 2.4 %, main pitch exact 14/18, 7/14 |
| + data, pitch | ea233ef1 | 21.9 | 20.9 | main pitch exact 15/18, 8/14 |
| + labels | 6d9e8b99 | 20.5 | 20.5 | conflict in roof-3d-dump.ts only |
| + walls | 04f4776a | 20.1 | 20.2 | labels' measuredRidge and walls' stepTopM named the same line: a tall step (height map jumps stepTopM across the line) stays a wall; three test controls switch both rules |
| + primitives | 35c0955a | 18.1 | 20.2 | main pitch exact 14/18 (the fitted gable) |
| + dormers | 6a8b49ac | 18.0 | 20.2 | ALL GATES PASS (349 dev, 264 held-out); roof tests 458/458 |
| photo-faces | not merged | - | - | no win, off by default, 13 conflict hunks: left on its branch |
Per-line table, 31 houses (algorithm 7 -> integrated): same kind within 0.75 m ridge 79->81, hip 70->73, valley 64->64,
eave 73->76, rake 60->66 %; nothing of ours there 7/13/17/10/12 -> 7/12/16/10/12 %.
Switch studies on the integrated branch (dev / held-out): faces.unsureThinM 0: 16.2 / 20.2; topology.stepPieceSettled false:
17.4 / 19.9 (fails thin-face gates on its own branch); topology.valleyDropM 0.3: 16.7 / 22.2 (kill: held-out valleys);
topology.flatX12 1.5: 17.4 / 20.2.
EXPECTED: held-out to follow dev. SAW: dev 21.9 -> 18.0, held-out 20.9 -> 20.2. The rules name lines better; what is left
is geometry that is not there at all: small features (turrets, nested hips, small gables: faces are 58-68 % of EagleView's),
non-roof covers counted as roof (area), jagged wall lines. Held-out hip total is a third short, eave and valley a fifth.

Sealed fresh houses (13 "high", nobody tuned on them; orchestrator only, run int-5-ev2), algorithm 7 -> round 2 integrated:
OBJECTIVE 26.5 -> 22.0 (ridge 15->14, hip 51->39, valley 22->24, eave 29->16, rake 15->16 %), area median 6.1 -> 5.7 %
(5/13 within 5 %), main pitch exact 10/13 -> 11/13. Round 2 holds on unseen houses. Every line total there sums SHORT
(ridge -20, hip -31, valley -14, eave -17, rake -17 %): roof left out. Told the area agent to hunt under-coverage with a
label-free check against Google's own area on all 84 houses.

## review of the round-2 merge (independent reviewer, read-only; scripts in /private/tmp/claude-501/review-roof2)
No P0. Determinism, fuzz (250 rasters), stored fields, offset-applied-once, indices and signs: sound.
| finding | sev | status |
|---------|-----|--------|
| buildFaces runs out of its 12 rounds (split -> "explained" -> split again; 80 planes into the old budget) | P1 | sent to the roof3/faces agent (its code) |
| measuredEdge at 0.25 m pixels reads rakes as eaves (sample on the edge roll-off) | P1 | FIXED 0ab87eca: window starts 3 px in; synthetic sweep at 0.25 m worse 9 -> 6, better 7 -> 10; 0.1 m unchanged |
| stepTopM 0 switched measuredRidge off on walls | P2 | FIXED 0ab87eca |
| two ridge tests could not fail for the rule they name | P2 | FIXED 0ab87eca (each switches the other rule off in both runs) |
| stepPieceSettled test has no case where settling matters | P2 | open |
| hidden-edge crop pad drops the fitted-plane lock (hidden edge is off in production) | P2 | open |
| lidar faces get Google's pitch offset (lidar off by default); pooling merges 5/12 with 6/12 | P2 | sent to the roof3/pitch2 agent |
| canopy re-crop calls buildFaces without `unsure` | P2 | sent to the roof3/faces agent |
| fitted faces still take the 0.8 confidence penalty; structures get only tuning.pitch; override rescales rise by reported pitch | P2 | open |
| runtime: 80-plane search adds ~300 ms on the biggest roofs (four houses 1.0-1.5 s through roofOnLayers; gate passes) | P2 | open (watch after round 3) |
| ROOF_3D_ALGORITHM_VERSION still 7 | must | bump to 8 at the final merge |
After the fixes: scorer unchanged (dev 18.0, held-out 20.2), 458 roof tests, 169 roof-bench tests.

# ROOF ROUND 3 (2026-11-21): aimed at what is missing, not at names
brief: ~/RooflineWork/plans/roof3-brief.md. Base: roof2/integration 6a8b49ac + this note. Worktrees ~/RooflineWork/wt-r3-*.
| track | branch | idea | result |
|-------|--------|------|--------|
| area | roof3/area | houses over 5 % area error: non-roof covers, dropped parts, overhang, pitch share | running |
| faces | roof3/faces | keep or drop a candidate face on evidence learned from EagleView's faces, not on size | running |
| small | roof3/small | features the plane search never finds: nested hips, hip ends, bays/turrets, small gables, fitted from residuals | running |
| lines | roof3/lines | straight walls and creases, squared corners, no zig-zag round flat parts; low-slope hips | running |
| pitch2 | roof3/pitch2 | steep and mixed-pitch roofs read low (9 for 12), pitch to area | running |

- 14:5x: all five round-3 agents stopped on the Fable usage limit (reset 3 pm PT); work saved in their worktrees. Owner said
  "Restart": all five resumed at 15:08 by message (same agents, same worktrees), told to land what they have first.

## round 3 results
- pitch2 (Fable) DONE b1eca76a, MERGED: partial. Main pitch exact dev 14 -> 15/18, faces within 0.5/12 72 -> 75 %; held-out pitch 8/14 flat,
  area 2.3 -> 2.6 % from pitch.stepShare (5/12 and 6/12 stay two groups: kept on for correctness). Blur is NOT why steep faces
  read low (ridge blur 0.14 m); pitch is limited by missing faces. offsetLidar guard in. roof-model override now scales rise from fitPitchX12.
- faces (Fable) DONE 3705deeb, MERGED, OFF by default: evidence rule (faces-evidence.ts). On: dev 18.0 -> 15.4, held-out 20.2 -> 17.9,
  faces 58 -> 68 %; area 3.9 -> 4.9 / 2.6 -> 3.5 %, thin-face + area gates fail. Thin gate is wrong (53/63 thin faces real). P1 loop fix
  in but off (run to the end the size rules delete 19 more real faces). Oracle: joining fragments by answer key = dev 14.7.
- area, small, lines (Fable): stopped by the orchestrator on the owner's order to switch models; work committed, base merged in.

# ROOF ROUND 4 (2026-11-21, owner: "replace the agents with Opus 5.5 MAX... accuracy on all levels to the point where it is insane...
#   new solutions that have not been tried before... as many agents as needed")
brief: ~/RooflineWork/plans/roof4-brief.md (addendum to roof3-brief.md). Base roof2/integration 87646a15. All agents Opus 5.5, max effort.
| track | worktree / branch | kind | idea | result |
|-------|-------------------|------|------|--------|
| area | wt-r3-area / roof3/area | continue | eave trim, non-roof covers, under-coverage vs Google on 84 houses; must bring area with evidence on back under default | running |
| small | wt-r3-small / roof3/small | continue | fitted small gables, hip ends, bump-out hips, turrets | running |
| lines | wt-r3-lines / roof3/lines | continue | regularise.ts: straight walls/creases, spurs, low-slope names; global corner solve | running |
| faces2 | wt-r4-faces2 / roof4/faces2 | continue | per-face evidence flag + gates-v4 thin check, fragment join by model selection, negative-evidence size rules | running |
| skeleton | wt-r4-skeleton / roof4/skeleton | NEW | roof as the weighted straight skeleton of the outline, per-edge eave/gable + pitch fitted to the heights; hybrid per part | running |
| refine | wt-r4-refine / roof4/refine | NEW | analysis-by-synthesis: render model through the blur, energy with complexity cost, continuous solve + split/merge/drop moves | running |
| sharpen | wt-r4-sharpen / roof4/sharpen | NEW | restore the height map first (piecewise-planar + photo-guided normals) so the unchanged pipeline sees small faces | running |

## next
- wait for the seven reports; merge winners behind the gates; sealed fresh set once; reviewer; remediation; algorithm 8;
  then ask the owner to merge + deploy.

## status
state: running (roof round 4; seven Opus max agents in flight)
needs-me: nothing now
