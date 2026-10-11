# Ops handoff: building Roofline off the Mac

This folder is how the build continues in a Claude Code cloud session. On 2026-10-11 the build moved off the
owner's Mac, which had hit a load average of 240+ on 10 cores. Everything a new session needs is here or in
git. Read this first, then `ops/sdd/f2/progress.md` and `ops/sdd/f3/progress.md`, which are the ledgers.

## The owner's standing rules

- **Just build.**
  - Take the recommended option and don't stop for plan or design approvals.
  - Stop and ask only before: merging or pushing to `main`, spending money, sending messages to real people,
    deleting data, or entering credentials.
- **Pushing is approved** for task branches and integration branches (`f2-shell`, `f3-setup`) to the private
  repo `parsasalahshori/roofline`. Never force-push. Never merge into `main`; `main` holds only the specs, the v1
  baseline and the CI registration commit.
- **Team structure** (the owner's design):
  - 1–2 Opus architects know the whole system: the session controller and an "Architect 2" agent for plans.
  - One Opus contact per 3 Sonnet leads.
  - One Sonnet lead per task, with up to 3 Haiku builders on disjoint files.
  - The Sonnet lead reviews the Haiku code and proposes fixes. The Opus contact approves, amends or rejects each
    fix. Haiku applies the approved fixes.
  - At most 3 rounds, then the lead fixes the rest itself and commits.
  - The Opus contact finally checks that its 3 tasks fit together and writes the merge plan.
  - Implementation: `ops/team/roofline-team.js`, a Workflow script. Pass `binDir: "<repo>/ops/bin/"` in args.
    Each task names its own worktree, branch, base, brief, report, verify command and context. Modes:
    - `build`: a new task
    - `resume`: unfinished work is already in the worktree, so plan the rest
    - `review`: review and fix an already-built task
    - `ci: true`: after committing, the lead runs `ci-check`
- **Testing:**
  - GitHub Actions runs the full suite (lint, typecheck, every package including the Testcontainers PostGIS
    db/api suites) on every push except to `main`.
  - `ops/bin/ci-check` pushes the current task branch and waits for the run. It judges only the Platform job,
    because old task branches carry an empty v1 data file, fixed on `f2-shell` in 0b81e1b.
  - Locally, run only focused test files.
  - `ops/bin/dbtest` limits local database test runs to 2 at a time. Without Docker, skip local db tests and
    rely on CI.

## Where things stand

### F2: the shell and design kit (plan `docs/superpowers/plans/2026-10-11-roofline-f2-shell.md`)

**Integration branch `f2-shell`:**
- **Merged:** Tasks 1–5, 10, 11 and 12. These are the design kit, the web scaffold and copy rules, the kit
  primitives, the window/sheet/dock/top bar/toast components, ReviewSteps, the API client and auth pages, the map
  home, and the shell.
- **CI:** green on the Platform job at 1f2fd00. The v1 data file was restored in 0b81e1b.

**Task branches** (all pushed):

| Branch | Head | State | What's next |
|---|---|---|---|
| `f2-t5` | f3b43ad | Already contained in `f2-shell` | Team review: `review` mode, base 5494fc1, verify ui/lint/css/typecheck. Merge any fix commits. |
| `f2-t6` | e86e649 | Built | Team review with `ci: true`, base 5494fc1. Check that `/api/approvals` doesn't parse 1 MB bodies before the session gate; only signed-in requests should get the larger limit. |
| `f2-t7` | c2173ff | Built | Team review with `ci: true`, base 5494fc1. Hide jobs of archived customers from search and pins. Share `customerMatch` with `listCustomers`. |
| `f2-t8` | 46778b0 | Built | Team review with `ci: true`, base 5494fc1. Its full api/db suite has never completed. |
| `f2-t9` | 0571e78 (WIP) | Stacked on `f2-t7` c2173ff | Resume: `resume` mode, base c2173ff, `ci: true`. |
| `f2-t14` | 66b7ccb (WIP) | Approvals UI | Resume: base 1fb5bd7. No Playwright specs yet (Ruling P). Hooks go in `features/approvals/api.ts` (Ruling Q). |
| `f2-t16` | 57f9715 | Settings, committed by its team | Review state unknown (the team stopped after committing). Run a `review` pass, base 1fb5bd7. |
| `f2-t10`, `f2-t11`, `f2-t12` | | Merged | Nothing. |

**Not started:**
- **Task 13:** the e2e stack and shell specs. Needs T6, T8 and T9 merged. Launch Chromium with
  `--use-angle=swiftshader --enable-unsafe-swiftshader` so the map summary renders.
- **Task 15:** the Today window. Needs T16's `useCompany` and T6's `/api/me/today-shown`.
- **Task 17:** the phone layout. Includes R4-1, 40px pin hit layers (Ruling N), plus `--shell-top-inset` and
  `--shell-bottom-inset`.
- **P1 polish (Ruling O):**
  - lazy-load MapView, since the bundle is 1.4 MB
  - company switch removes the non-me queries
  - StormWindow summary null-guard
  - move `Bbox` into `api/types.ts`
  - move `auth.test.tsx` onto `test/helpers.tsx` with one timeout source
  - `jsx-quotes` prefer-double
- **The Playwright specs** deferred from T14 and T15. These come after T13.

**Merge rule:** merge reviewed branches into `f2-shell` with `--no-ff`, in dependency order.
- T6 → T7 → T8 → T9 → T14 → T16.
- Resolve `packages/db/src/index.ts` and `apps/api/src/app.ts` conflicts by keeping both sides' lines.
- Use the Opus contact's group-check merge notes. `ops/sdd/f2/merge-wave-a.md` is an example.
- After merging, push `f2-shell` and let CI confirm.

### F3: sign-up, billing, setup, import, texting registration (plan `docs/superpowers/plans/2026-10-11-roofline-f3-setup.md`, 37 tasks)

- **Integration branch:** `f3-setup` at 7b4e8b4 (the plan), stacked on `f2-shell` at 5494fc1.
- **WIP branches** (resume each, base 7b4e8b4, `ci: true`):
  - `f3-t1` (4e6971a): schema and skeleton
  - `f3-t2` (3d92b01): deploy hardening
  - `f3-t8` (0466b73): textable numbers
  - `f3-t12` (10693ab): lease heartbeat
- **Next:** the remaining tasks follow the plan's "Parallel lanes" table. Task 9 (the API skeleton) waits for F2
  Tasks 6–9 to be merged into `f2-shell` and then into `f3-setup`.
- **Briefs and ledger:** `ops/sdd/f3/`. Make more briefs with the superpowers `task-brief` script, or copy the
  task's section from the plan.

### After Foundation

Feature sub-projects, per the master spec §8, each with its own spec, plan and team build:
- Core CRM
- Estimator and homeowner page
- Storm Scout
- Front Desk
- the Agents screen
- Claims, Scheduler and Follow-up

## Hazards learned the hard way

- **The PostGIS test image is amd64-only.** On Apple Silicon it runs emulated. Stopped runs leave containers
  that each burn about one core.
- **The original Mac checkout is in iCloud-synced ~/Documents.** A file there can report size 0 while its content
  reads fine, and git then commits an empty blob. Check with `git ls-tree -r -l HEAD | awk '$4==0'`.
- **Under Vitest, `react-router` and `react-router/dom` load as two copies.** Tests import `RouterProvider` from
  `react-router`.
- **Web tests time out under heavy load.** `apps/web/vitest.config.ts` sets 15 s.
- **Several `role="status"` regions are always mounted.** Tests find banners and summaries by their text.
