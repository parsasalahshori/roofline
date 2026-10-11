important [18]: T18 goes beyond its brief's file list in three places: apps/api/src/tasks/demo.ts (sendTime 'Today 10:00 AM' -> 'today at 10:00 AM'), apps/api/test/seed-demo.test.ts, and apps/web/e2e/fixtures.ts (markTodaySeen now uses each company's companies.timezone instead of a hard-coded 'America/Chicago'). The brief said 'reads, does not change' fixtures.ts and named no apps/api edits. Each change is reasonable: the sendTime one fixes the deferred T9/T14 minor so the review reads 'Sends today at 10:00 AM · quiet hours respected'. But seed-demo.test.ts is database-backed and cannot run on this machine, so the only proof is CI.
 -> Accept all three, but do not merge until the ci-check run on f2-t18 is green in both the API test job (seed-demo.test.ts) and the E2E job. List the out-of-scope edits in the T18 report and close the sendTime minor in ops/sdd/f2/progress.md. packages/shared/test/steps.test.ts still uses 'Today 10:00 AM' as a plain parse fixture. That is harmless, so leave it.

important [18]: T18 changes product code in apps/web/src/features/today/useTodayAutoOpen.ts: Today now opens only if the current path is still '/' when the server answers. This is the defect fix the brief allows the lead to make. One side effect is left: the POST /api/me/today-shown call has already recorded the day as shown on the server. So if someone opens a dock app before the answer arrives, they never see Today that day.
 -> Merge as is. Record the defect fix in the report, and note the 'marked shown but never opened' edge as a minor for a follow-up. The fix would be to ask only on open, or to post a separate 'opened' acknowledgement.

minor [18]: apps/web/test/today.test.tsx has formatting-only rewraps of existing tests (findByRole, makeTask and mount calls split across lines). The repo has no Prettier config, and its style uses long lines. This churn is unrelated to the new test and will cause needless conflicts if any F3 branch edits today.test.tsx.
 -> Optionally ask T18 to revert the rewraps and keep only the new test 'does not hijack a page the person opened before the answer arrives'. If a later branch conflicts here, keep the other branch's lines and re-add only that test block.

minor [18]: In phone.spec.ts, 'Approve stays pinned' scrolls with mouse.wheel, but the review page may be too short to scroll. If so, the test passes without proving the footer is sticky. Separately, 'long text does not widen the page' changes customers.display_name, and the review window may not show customer names.
 -> No merge blocker. When F3 T36 extends phone.spec.ts, consider making the review content taller before the scroll, for example by reusing the long-text SQL, so the pinned-footer check means something.

minor [18]: ops/sdd/f2/f2-acceptance.md ends with a 'Not yet green on CI' section that lists every e2e spec and the unit tests as not yet confirmed.
 -> After ci-check reports a green E2E job (desktop and phone) and green unit jobs on f2-t18, have the controller or T18 strike those lines before F2 is declared accepted.

Scope: only T18 is in this group. Branch f2-t18 is one commit (efa39ff) on base d223d91, and its working tree is clean. It changes 12 files: approvals, today, phone and a11y specs in apps/web/e2e; the shell.spec.ts deep-link test; fixtures.ts markTodaySeen; useTodayAutoOpen.ts plus a new unit test; the API demo seed's sendTime and its test; the CI E2E run line; and ops/sdd/f2/f2-acceptance.md.

Integration branch: origin/f2-shell (8084611, the same commit as f2-shell-wbg3ja) is 11 commits past d223d91, all ops/docs commits plus the rep-visibility flake fix. The local branch ref f2-shell (b51c7c1) is stale; merge into origin/f2-shell, not the local ref. A trial `git merge-tree origin/f2-shell f2-t18` is CLEAN.

Only shared file: .github/workflows/ci.yml. origin/f2-shell changed the push paths-ignore (adding 'docs/**'), and T18 changed the E2E run line to `npm run e2e -- --project desktop --project phone`. The hunks don't overlap, so git merges them on its own. If a conflict ever shows up there, keep both changes.

Interfaces checked:
- Copy strings used by the specs match apps/web/src/copy: 'Map showing 70 customers and 25 open jobs.', the approve-button labels from the brief, and the review.sendTime template now producing 'Sends today at 10:00 AM'.
- The fixtures used (loginAs, markTodaySeen, scenario, db, click/clicks) all exist. loginAs signs in through the API only, so it never visits '/' and the Today deep-link test stays valid.
- The playwright config has 'desktop' and 'phone' projects; phone runs only phone.spec.ts, so a11y.spec.ts runs in desktop only.
- @axe-core/playwright is already a dependency, and no package.json changes were made.
- No JSX or raw <button> was added.

The new unit test replaces globalThis.fetch directly. vi.unstubAllGlobals in afterEach restores it, so nothing leaks into other tests.

Before merging, require a green ci-check run on f2-t18, including the E2E job with both projects and the DB-backed seed-demo.test.ts. Then update the acceptance map's 'Not yet green on CI' section. F3 Task 36 will add tests to phone.spec.ts and a11y.spec.ts, so merge T18 first.
