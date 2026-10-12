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

- **This repo is PUBLIC.** Never commit secrets, API keys, tokens, `.env` files or real customer data.

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
| F3 setup, texting, billing, import | `docs/superpowers/plans/2026-10-11-roofline-f3-setup.md` (on `f3-setup`) + briefs `ops/sdd/f3/` | **done** (8b8400a): 37 tasks, polish, integration-review fixes A-C |
| C1 Core CRM | `docs/superpowers/plans/2026-10-12-roofline-core-crm.md` + briefs `ops/sdd/c1/` | **done** except T29 (owner: real Google/Outlook smoke); T1-T28 + whole-branch review on `c1-crm` |
| E1 Estimator | `docs/superpowers/plans/2026-10-12-roofline-estimator.md` | **done** (630ffcf): T1-T22 + whole-branch review; owner runs T22 smoke |
| S1, D1, A1, G1 | `docs/superpowers/plans/2026-10-12-roofline-*.md` + briefs `ops/sdd/{s1,d1,a1,g1}/` | G1 all tasks T1–T18 merged (g1-agents bbf8e5d); A1 all tasks 1–22 merged, re-merges in flight; S1 security fixes R8–R10 in progress; D1 T19 plus pre-review fixes (CV, RA, RC, d1-rev-a/b/c) in progress |

All finished branches are merged (2026-10-12): F3 T26, T31-T35 into `f3-setup` (330ca23); C1 T2-T4 and the
latest `f3-setup` into `c1-crm` (dfa9132).

Then F3 Tasks 28, 37 and finally 36 (briefs in `ops/sdd/f3/`), merge `f3-setup` into `c1-crm`, and continue
C1 from its plan's "Parallel lanes" table (next: T5 API skeleton, T18 web skeleton).


## Parallel tracks (owner: "go", 2026-10-12)

Milestones now run in parallel. Each track's integration branch started from `c1-crm` dfa9132 and later
merges `c1-crm` (and its upstream milestone) in as they land:
- Track A: `c1-crm` (C1), then `e1-estimator` (E1), then `s1-storm` (S1).
- Track B: `d1-front-desk` (D1): early waves now, calendar-dependent tasks after C1's calendar lands.
- Track C: `a1-agents` (A1), later `g1-agents` (G1): early waves now.
A task whose brief depends on an unbuilt upstream name ([C1], [E1], [S1], [D1], [A1]) waits, or uses a
scratch stub commit that the merge replaces (as C1 T2-T4 did; record the merge rule in the ledger).

Track sessions (Claude Code cloud): C1 session_01MpVA7xTz6Bus8WPNZWUKRq; E1 session_01UtFnF1PL9Tbc2z44JfhQDM;
S1 session_01XaGX8pcLBpR2SWeGqsd3gP; D1 session_0166agXYjDy39PFyUw1BXtLR; A1 session_01XjgURUvqk4BGTeumR86x2a; G1 track
session_01NbXKpWjMvEQwTqNmQCt6wp; F3 review + T36 session_01RypesnL2fbawyJH5HtdS7E; controller
session_01LXtxzoHNoWz5SACkLF1d2p. Each track lead owns and pushes its own integration branch.

**Ruling AP (migration numbers, overrides every plan and brief):** F3 ends at 0012; C1 = 0013/0014;
E1 = 0015/0016; S1 = 0017/0018; D1 = 0019/0020; A1 = 0021/0022; G1 = 0023/0024. Each track generates its
migrations on its own base. When merging tracks together, the controller fixes the drizzle journal order
and rebuilds the snapshots (`drizzle-kit generate` must then report no changes). Known cross-track overlap:
D1 T1 (0019) and G1 T1 (0023) both add a unique (company_id, id) on `messages`; D1's wins and G1 drops its
copy when it merges d1-front-desk (keep exactly one constraint, D1's name).

**Ruling AQ (builder model):** team-script builders are Haiku 5.5 by default. Set the task field
`builder: "sonnet"` for: UI integration across the shell (Shell, router, windows, phone layout), concurrency
and locking (jobs, leases, advisory locks, SKIP LOCKED), migrations and RLS, LLM conversation/guardrail logic
(D1, G1), and the Python hail service (S1). Leads, contacts and reviews are unchanged (Sonnet 5.5 leads,
Opus 5.5 contacts).

**Ruling AV (shared inbound-text hook):** in `apps/api/src/hooks/twilio.ts`, after the inbound message is stored,
the calls run in a fixed order (amended per the G1 spec §3.3): S1 `onStormReply`, then G1 claims (marked
`// G1 Agents`; only acts when the customer got a claims text in the last 7 days, and when it consumes a reply
it calls D1's path itself for "Thanks, got it." or the continuation), then D1 `queueFrontDeskText`. A later
handler skips a message an earlier one consumed. Tracks do not wait for each other: each adds its own
call, and the merger keeps both in this order.

**Ruling AW (pre-release migration edits):** nothing is deployed, so a track may amend its own custom
migration (grants, RLS, CHECK swaps) in place instead of taking a new number. Afterwards check that
`drizzle-kit generate` reports no changes, and record the edit in the track's ledger.

**Ruling AY (journal timestamps and step shape):** on every integration branch, the drizzle journal `when`
values must strictly increase with the migration number, because drizzle skips any migration older than the
last one applied. Whoever merges a lower-numbered track in after a higher-numbered one raises the later
entries' `when` (edit the journal; do not regenerate). Since A1 T3, every `StepTypeDef` is a plain object
with `userCreatable`, `baseline` and `units`, and has no `minutesSaved`; `withMinutesSaved` is gone. E1's
`send_proposal`/`order_exact_report` and all S1 step types must use that shape. A1 fixes E1's two step types when it merges e1-estimator.

**Ruling BA (integration pass 2 fixes; each is done by whoever does the merge named):**
- Step types: write them as plain `const x: StepTypeDef<P> = {...}`; tests read `stepMinutes(def, p, result).minutes`.
  G1 converts its four at its a1-agents merge, and E1 and S1 fix their tests at theirs.
- `JOB_SOURCES` gains `front_desk` (D1). When D1 merges c1-crm, add `front_desk: 'Front Desk'` to the
  `sourceNames` map in `create.ts` and to the `source` map in `jobs.ts`. C1 hides it from NewJob's
  `sourceOptions` and keeps it in the board filter.
- Setup checklist counts and shell tab/app counts in tests: whoever merges a shipping feature in updates the tests
  of the other track (E1, D1 and S1 recount the setup "Coming with" lines when they ship their setup items).
- Journal `when` (Ruling AY): S1's 0017/0018 are newer than 0019-0024, so wherever s1-storm combines with D1/A1/G1,
  raise 0019+ above 0018. The controller normalizes every `when` to strictly increasing at the launch merge.

**Ruling BB (rep price visibility):** reps may see the full price list through the quote editor (they quote
prices to homeowners); job values hidden from a rep stay hidden. The C1 lead now helps S1 on tasks the S1 lead assigns.

**Ruling BC (Storm Scout pause and reruns):** `draftStormPlan` checks the pause first and returns `{taskId} | null`
(null = paused: no task, no alert); `POST /api/storms/:id/plan` answers 409 "Storm Scout is paused. Turn it back on in
Agents to draft a plan." A storm_plan rerun re-drafts through `draftStormPlan` with fresh data; other reruns keep each
step's off state. S1 adds the D1/G1 step titles to `OFF_STEP_TITLES` at its d1/g1 merges.

**Ruling BD (one storm re-draft mechanism):** A1 owns it (`lockStormPlan`/`supersedeDraft`/`linkStormPlan`,
`REDRAFTABLE` = draft, expired, declined, no `replaceFinished` flag). S1 adds only the `{taskId} | null` signature and the
paused 409 route; A1's re-draft code wins at merge. Amended: the automatic path (storm-match, scheduled drafting) re-drafts only over drafts; expired/declined plans are
replaced only by an explicit rerun (`allowFinished`, set only by explicit owner actions; see the clarification below).

**Ruling BF (security review fixes, `ops/sdd/integration/security-review.md`):** S1 fixes HIGH 1 (cross-company ad
accounts), HIGH 2 (unsubscribe/landing Referrer-Policy + browser e2e), MEDIUM 3 and its LOWs; D1 revokes app_system SELECT on
conversation text (MEDIUM 6); the E1 lead fixes platform items (TRUST_PROXY startup check, login limits, F2/F3/E1 LOWs) on
`sec-core` from c1-crm and merges into c1-crm. Grant/index changes go in the owning unreleased migration (Ruling AW).
**Ruling BG (D1 read-only companies, pre-review item 22):** voice and fd-text check company status. A read-only company (trial ended or cancelled) gets voicemail or forwarding and no AI. The Front Desk "off" write is always allowed, even while read-only. Recommended option taken; the owner may revisit it.
**Ruling BD clarified (final, 16:45Z, supersedes the 16:40Z message):** `allowFinished` is set only by explicit owner actions: the rerun route and `POST /api/storms/:id/plan` (S1's "Draft a new plan" button on expired or declined plans). Automatic paths (storm-match, scheduled drafting) never set it. A1 returns `fresh: !previousWasDraft`.
**Ruling BH (A1 T23):** setting a next step on a job that had none counts as a change, and it closes that job's open Front Desk live tasks.
**Ruling BI (D1 retention, final-review N6):** the retention sweep blanks only the AI exchange: inbound texts the assistant handled, and the assistant's replies. It keeps STOP/START/HELP keyword bodies (the compliance record), staff replies and booking confirmations. The settings copy says exactly that. Retention 0 deletes existing recordings, and the copy says so. Recommended option taken; the owner may revisit it.
**Ruling BJ (D1 stale-call sweep):** `endStuckCalls` lists company ids on the system pool, then updates per company on the tenant pool inside `withTenant`. No app_system UPDATE grant on calls (in line with BF and the rev-d sweep rule).

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
- `drizzle-kit generate` names its new snapshot by the next free number on your base, which can overwrite another
  track's `meta/00NN_snapshot.json` after a merge. Check `git status` and restore any other track's snapshot from origin.
- Column-level grants: the shared timestamps helper (`packages/db/src/schema/columns.ts`, `$onUpdate`) adds `updated_at` to every Drizzle UPDATE. A narrowed `GRANT UPDATE (col)` must also list `updated_at`, or every update on that table is refused (D1 voice-URL failure).
- Local full-stack runs work in cloud sessions: start Docker with `nohup dockerd &` (as root), then `postgis/postgis:16-3.4` pulls and the e2e stack (PostGIS, API, worker, web) boots. You can run DB, API and e2e suites locally before pushing; CI stays the merge gate.
- `apps/web/e2e/shell.spec.ts` dock test needs its 60 s timeout. Find banners by text: several
  `role="status"`/`role="alert"` regions are always mounted.
- Under Vitest, import `RouterProvider` from `react-router` (not `react-router/dom`).
- `ops/team/roofline-team.js` and `ops/bin/*` are tooling for Claude Code (Workflow scripts, a curl-based
  CI watcher). They are not needed on other platforms.
