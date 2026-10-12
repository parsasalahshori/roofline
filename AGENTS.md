# Roofline: instructions for coding agents (Codex and others)

Roofline is a multi-company SaaS for roofing companies: a map-first web shell, CRM, estimator and
proposals, storm (hail) alerts and ads, an AI phone/text front desk, and an agents dashboard. The work
moved here from Claude Code cloud sessions on 2026-10-12. Everything is in this GitHub repo; nothing
lives anywhere else.

## Start here

1. `docs/superpowers/roadmap.md`: milestone order, dependencies, status, and the owner's to-do list
   (accounts, money, credentials, lawyer).
2. `ops/README.md`: branch state, standing rules, hazards (its last section is the latest state).
3. The ledger for the milestone you work on: `ops/sdd/<milestone>/progress.md`. Every ruling ("Ruling X: …")
   is binding unless the owner overrides it. Append to the ledger when you finish or decide something.

## Owner rules

- Just build: take the recommended option and keep going. Do not stop for plan or design approval.
- Ask the owner first before: merging or pushing to `main`, spending money, messaging real people, deleting
  data, entering credentials, or creating accounts with outside services.
- Never push to `main` (it holds only specs, the v1 baseline and the CI registration). Never force-push.
- Push task branches and integration branches freely. Integration branches: `f2-shell` (done), `f3-setup`,
  `c1-crm`, later `e1-estimator`, `s1-storm`, `d1-front-desk`, `a1-agents`, `g1-agents`.

## Where things stand (2026-10-12)

| Milestone | Plan | State |
|---|---|---|
| F1 platform core | `docs/superpowers/plans/2026-10-10-roofline-f1-platform-core.md` | done |
| F2 web shell and design kit | `docs/superpowers/plans/2026-10-11-roofline-f2-shell.md` | **done**: Tasks 1-19 + P1 on `f2-shell`, CI green incl. e2e |
| F3 setup, texting, billing, import | `docs/superpowers/plans/2026-10-11-roofline-f3-setup.md` (on `f3-setup`) + briefs `ops/sdd/f3/` | 29 of 37 + polish P3a/P3b merged on `f3-setup` |
| C1 Core CRM | `docs/superpowers/plans/2026-10-12-roofline-core-crm.md` + briefs `ops/sdd/c1/` | Task 1 merged on `c1-crm` |
| E1, S1, D1, A1, G1 | `docs/superpowers/plans/2026-10-12-roofline-*.md` + briefs `ops/sdd/{e1,s1,d1,a1,g1}/` | planned, briefs ready |

Finished, CI-green task branches NOT yet merged (merge these first, `--no-ff`):
- Into `f3-setup` (all based on `ebcc93c`): `f3-t26` f9efe6f, `f3-t31` 64ac1b6, `f3-t35` 95e35a3,
  `f3-t32` 2b7918c, `f3-t33` 919b204, `f3-t34` 8d0f7f0. Their group check never ran: run typecheck, lint
  and the web tests after merging. Reports: branches `ops-sib2e`, `ops-sib3d`. Carry: give `.banners`
  z-index 24 (T32/T33).
- Into `c1-crm`: `c1-t2` 1a73b7a, `c1-t3` bbad8ec, then `c1-t4` cd99713 (take T2/T3's `pipeline.ts` and
  `availability.ts`). Reports: branch `ops-sib1e`.

Then F3 Tasks 28, 37 and finally 36 (briefs in `ops/sdd/f3/`), merge `f3-setup` into `c1-crm`, and continue
C1 from its plan's "Parallel lanes" table (next: T5 API skeleton, T18 web skeleton).

## How to do a task

1. Read the brief `ops/sdd/<milestone>/task-<N>-brief.md`, the milestone's `global-constraints.md`, and the
   plan section it names.
2. Branch from the integration branch: `git checkout -b <milestone>-t<N> origin/<integration>`, or resume
   the existing task branch if one exists (WIP commits stay; commit on top, never rewrite them).
3. Work test-first. Keep to the files the brief lists.
4. Verify locally (below), commit, push the task branch, and confirm GitHub Actions is green.
5. Merge into the integration branch with `git merge --no-ff`, in dependency order, run typecheck and lint
   on the result, push, and let CI confirm. Record the merge and any rulings in the ledger.
6. When a milestone is complete, run a whole-branch review, fix what it confirms, then start the next
   milestone's integration branch from the previous one (see the roadmap's branch chain).

## Commands

- Install: `npm ci` (Node 22.13+).
- Typecheck: `npm run typecheck`. Lint: `npm run lint` and `npm run lint:css`. Web build: `npm run build:web`.
- Unit tests without a database: `npx vitest run --project @roofline/web` (also `@roofline/ui`,
  `@roofline/shared`, `@roofline/send-gate`).
- Database-backed suites (`@roofline/db`, `@roofline/api`, `@roofline/worker`) start a PostGIS container with
  Testcontainers and need Docker. If your environment has no Docker, do not try to run them: push and let
  GitHub Actions run them (the `Platform` job). The `E2E (Playwright)` job runs the browser specs.
- E2E locally (needs Docker): `npm run e2e -- --project desktop`. Without Docker: `npx playwright test --list -c apps/web/playwright.config.ts`.
- CI: `.github/workflows/ci.yml` runs on every push except to `main`, and skips pushes that only touch `ops/` or `docs/`.

## Code rules (full list in each milestone's `global-constraints.md`)

- TypeScript strict, ESM, explicit `.ts`/`.tsx` extensions on relative imports.
- Web: CSS Modules with the S1 design tokens; no letter-containing literal text in JSX (copy lives in
  `apps/web/src/copy/*.ts`); no raw `<button>` (use `@roofline/ui`); new feature hooks go in
  `apps/web/src/features/<feature>/api.ts`.
- Database: every tenant table has `company_id`, RLS forced with the `tenant_isolation` policy, and is listed
  in `TENANT_TABLES`; routes reach data only through `packages/db` repos inside `withTenant`.
- Paid providers (Stripe, Twilio, Geocodio, EagleView, Google/Meta Ads, Anthropic, ...) sit behind seams with
  fakes. Tests and CI never call a live provider.

## Hazards learned the hard way

- `package-lock.json`: after any lockfile merge or install, `npm ls playwright-core` must show only 1.56.1.
  If not, rebuild the lockfile from `f2-shell`'s lock with `npm install --package-lock-only`.
- Migrations: F3 ends at `0012_early_reports_prune.sql`; C1 owns `0013`/`0014`. Never reuse a number. To
  generate, run from `packages/db`: `../../node_modules/.bin/drizzle-kit generate --name=<name>` (the npm
  script does not pass `--name`). drizzle-kit emits FKs before unique constraints; reorder by hand if needed.
- `apps/web/e2e/shell.spec.ts` dock test needs its 60 s timeout. Find banners by text: several
  `role="status"`/`role="alert"` regions are always mounted.
- Under Vitest, import `RouterProvider` from `react-router` (not `react-router/dom`).
- `ops/team/roofline-team.js` and `ops/bin/*` are tooling for Claude Code (Workflow scripts, a curl-based
  CI watcher). They are not needed on other platforms.
