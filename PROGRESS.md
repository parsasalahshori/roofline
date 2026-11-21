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

## findings
(each agent reports a table; merged here at integration)

## paths (roof)
| path | idea | metric vs baseline | keep/kill | evidence |
|------|------|--------------------|-----------|----------|
| R1 | creases labelled by drainage: upper face draining onto a lower one along a near-level line = eave; same-way same-pitch = pitch break; opposite faces = ridge | dev ridge 28->19, valley 42->24, eave 24->19, hip 15->22, rake 26->26; held-out ridge 19->12, eave 22->12, valley 23->23, hip 42->42, rake 17->17 | keep | roof/better 39117427 + follow-up; dump-v2 |

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
- backoffice agent DONE: b/backoffice ddb2f128 (9 findings fixed incl. approve discount, accept -> factory order; journey spec passes twice).

## next
- launch the five area agents; re-fetch the roof benchmark's Google data (free quota) and freeze a fresh baseline.

## status
state: running
