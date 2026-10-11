# SDD ledger — plan: docs/superpowers/plans/2026-10-11-roofline-f2-shell.md

Spec: docs/superpowers/specs/2026-10-10-roofline-foundation-design.md §4 (+ master §5). Branch f2-shell, stacked on f1-platform-core (6f0f77c). Plan commit a371d01.

## Pre-flight scan

| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1↔T3/T4/T5 | tokens.css/tokens.ts, ui index.ts | consistent |
| T1↔T2 | root package.json, tsconfig refs, ci.yml, stylelint globs cover apps/web/src | consistent |
| T2↔T10 | T2 creates copy/auth.ts; T10 lists it under Create | conflict → Ruling A |
| T2↔T11/T16 | legal.ts (attribution), connections/billing/setup.ts | consistent (modify) |
| T3↔T4 | UiLink (T3) used by Dock/Pill/Button (T4) | consistent |
| T4↔T5 | Window footer prop vs ReviewSteps own sticky footer | consistent: ReviewSteps renders its footer inside Window body |
| T5↔T14 | ReviewStep/summarizeApproval/ReviewStepsCopy; T14 copy lists most keys (edit/retry/switchLabel implied by type) | consistent (TS enforces) |
| T6↔T13 | WEB_DIST_DIR, CSP upgrade-insecure off outside prod | consistent |
| T6↔T14/T15 | rerunOfTaskId; today-shown {show} | consistent |
| T7↔T9 | GeoJsonMultiPolygon (repos/map.ts) used by setServiceArea | consistent |
| T7↔T11 | PinsResult/MapArea mirrored in web types | consistent |
| T8↔T12/T13 | {weather}; WEATHER_DISABLED | consistent |
| T9↔T13 | seedShowcase, seedDemoTask exports, startTestDatabase | consistent |
| T10↔T12 | router, hooks.ts, keys.ts | consistent |
| T11↔T12 | MapView onOpen | consistent |
| T12↔T14 | approvals routes + storm/plans/:taskId are T14's; T12 test links to /storm/plans/t1 | gap → Ruling B |
| T12↔T17 | useIsPhone made in T12, consumed in T17 | consistent (fixed in self-review) |
| T13↔T14 | T13 deep-link test asserts plan title, but T12/T13 render a placeholder there | conflict → Ruling C |
| T15↔T16 | useCompany made in T15, reused in T16 | consistent |
| T1 self | tests vs files | consistent |
| T2 self | lint rule scope (src only, tests exempt) vs ui test files | consistent |
| T3–T5 self | consistent |
| T6 self | consistent |
| T7 self | consistent |
| T8 self | consistent |
| T9 self | consistent |
| T10 self | auth.ts listed as Create (see Ruling A) | |
| T11 self | consistent |
| T12 self | see Ruling B |
| T13 self | see Ruling C |
| T14–T17 self | consistent |

Ruling A: T10 modifies copy/auth.ts (T2 created it) — plan file list says Create — cost if wrong: none.
Ruling B: T12 mounts placeholder ComingSoon elements at approvals, approvals/:taskId and storm/plans/:taskId; T14 replaces them with the real screens — the plan names those routes as T14's — cost if wrong: one rewired route.
Ruling C: T13's deep-link e2e asserts only the URL and the dialog named "Need your OK"; T14 adds the plan title, Approve button and no-Today assertions — the review screen does not exist until T14 — cost if wrong: none.

## Tasks
Task 1: dispatched (BASE a371d01, implementer sonnet)
Task 1: implementer DONE_WITH_CONCERNS (f30026c). Notes: stylelint ignoreFiles scoping; font-size inherit/initial/unset flagged; d.ts for plugin.
Task 1: minor (deferred): F1 flake apps/api/test/rep-visibility.test.ts:400 asserts JSON lacks '333' — random UUIDs can contain it; fix in the final wave.
Ruling D: the 12px rule accepts CSS-wide keywords (inherit, initial, unset, revert) — they cannot go below a checked size (initial = medium) — carried into Task 3's dispatch — cost if wrong: a component could inherit a too-small size only from an unchecked ancestor, which the rule already blocks.
Task 1: review — spec ✅, Needs fixes: 1 Important (--font-size-* custom props never checked; floor bypassable).
Task 1: minor (deferred): font shorthand fails open on bare var() size; stylelint.config.js scoping untested (--allow-empty-input hides mistakes); --danger text 4.44:1 on --surface needs a usage comment; reduced-motion also kills animations; plugin deps only at root.
Task 1: Ruling D applied in fix round 1 (same file) instead of Task 3.
Task 1: fix round 1 dispatched; commit 1e155b7; re-review running
Task 1: fix round 1/5 (1 addressed + Ruling D applied, 0 open; commits f30026c..1e155b7)
Task 1: minor (deferred): header comment overstates `revert` (UA sets smaller on small/sub/sup); a unitless --font-size-scale would be flagged (latent); bare var() in font shorthand without '/' still passes.
Task 1: complete (commits a371d01..1e155b7, review clean)
Task 2: dispatched (BASE 1e155b7, implementer sonnet)
Task 2: implementer DONE_WITH_CONCERNS (3d33a7c). Notes: copy scanner skips type nodes/module specifiers; JSX selectors miss {'Hello'}; an unrelated node server holds *:4401 on IPv6 (Vite binds 127.0.0.1 fine); react-hooks v7 recommended includes compiler rules.
Ruling E: the no-literal-text lint also covers string literals in JSX children expression containers and in the five text attributes' expression containers (`JSXElement > JSXExpressionContainer > Literal[value=/[A-Za-z]/]`, `JSXAttribute[name.name=/^(aria-label|title|placeholder|alt|label)$/] > JSXExpressionContainer > Literal[value=/[A-Za-z]/]`, same for TemplateLiteral quasis) — spec says no inline literals in feature code; the brief's two selectors leave an easy bypass — cost if wrong: a few extra lint hits.
Task 2: review — spec ✅, Needs fixes: 1 Important (plan-mandated selectors miss {"x"}, {`x ${n}`}, title={"x"}, aria-description) — same gap as Ruling E; fix round 1 applies Ruling E.
Task 2: minor (deferred): unknown task status falls into "Mostly done"; loose **/api/src/** back-door pattern; index.html <title> duplicates appName; copy/setup.ts wording circular; no typed ImportMetaEnv (carry to Task 11).
Task 2: fix round 1/5 (1 addressed + Ruling E applied, 0 open; commits 3d33a7c..285a471)
Task 2: minor (deferred): template escapes flagged via value.raw (use value.cooked); 'a' + x and `as string` forms not caught; nesting capped at 3; npm audit reports 9 vulnerabilities (triage in final review).
Task 2: complete (commits 1e155b7..285a471, review clean)
Task 3: dispatched (BASE 285a471, implementer sonnet)
Task 3: implementer DONE (6608663). Notes: #fff on danger (4.51:1) is the one non-token colour; Button href keeps button attrs; Field/Select no explicit ref forwarding.
Task 3: review — spec ❌ (danger hover 4.39:1 via brightness filter), Needs fixes: 1 Important.
Task 3: minor (deferred): Toggle styles.label dead class; @testing-library/dom undeclared peer; UiLinkProvider JSDoc should say adapter must be module-level; href buttons lack target/rel (plan-mandated signature); busy disables (focus drop); multiline Field casts input props to textarea; untested branches (describedby merge, disabled link, Skeleton lines=1 60% width, lines=Infinity throws); literal radii 16/10/12/6px.
Ruling F: danger colours become tokens — `--on-danger: #ffffff` and `--danger-hover: #c92a2a` (white on it ≈ 5.6:1) — hover changes background only, no filter on danger — spec value --danger unchanged — cost if wrong: two extra tokens.
Ruling G: Button, IconButton, Toggle, Field and Select accept and forward `ref` (React 19 ref-as-prop) to their focusable element — Task 4's Window/focus return and later forms need it — load-bearing — cost if wrong: none.
Task 3: fix round 1/5 (1 addressed + Rulings F, G applied, 0 open; commits 6608663..7e5c046)
Task 3: minor (deferred): no regression guard for danger hover rules; ref through a UiLinkProvider adapter untested; Pill has no ref.
Task 3: complete (commits 285a471..7e5c046, review clean)
Task 4: dispatched (BASE 7e5c046, implementer sonnet)
Task 4: implementer DONE_WITH_CONCERNS (6058276). Notes: tab ring includes the close button; hidden controls skipped by computed style; Sheet inside Window shares its stacking context; page Window fixed inset 0 would cover phone tabs; ui peer react ^19.2 (useEffectEvent).
Ruling H: Sheet renders through a portal into document.body (createPortal) so it always stacks above the Window/dock; the page-variant Window's bottom edge is `var(--shell-bottom-inset, 0px)` so the phone shell can reserve the tab bar — both are needed by Tasks 14 and 17 — cost if wrong: small CSS/portal change.
Task 4: review — spec ✅, Needs fixes: 1 Important (Sheet open when its Window mounts: Window steals initial focus and records the Sheet as opener; restore lost; untested). Fix round 1 also applies Ruling H.
Task 4: minor (deferred): opener-gone test passes without the guard; body opener under StrictMode; tabbable scan cost; radio groups/summary/iframe/media not handled; toast no pause on hover + close inside live region; test hygiene (double blank, mockRestore outside finally).
Task 4: fix round 1/5 (1 addressed + Ruling H applied, 0 open; commits 6058276..5494fc1)
Task 4: minor (deferred): two sibling Sheets mounting together under one Window — second records first as opener; Sheet reads document.body in render (SSR only); TrapScopeContext not exported for custom traps.
Carry to Task 12/17: the shell must give the dock z-index 30 (Window 20, Sheet 40, toasts 50) and set --shell-bottom-inset on phone.
Task 4: complete (commits 7e5c046..5494fc1, review clean)
Task 5: dispatched (BASE 5494fc1, implementer sonnet)
Ruling I: parallel lanes (user instruction 2026-10-11 "keep running the implementation in parallel, don't go one by one" overrides the skill's one-implementer rule). Independent tasks run in their own worktrees under ~/RooflineWork/wt/t<N> on branches f2-t<N> (from 5494fc1); each is reviewed on its own branch range and merged --no-ff into f2-shell by the controller; the main checkout is for merges only once Task 5 commits. Implementers run focused tests; the controller runs the full suite after each merge — cost if wrong: merge conflicts in app.ts/config.ts/package-lock.json, resolved at merge.
Ruling J: Task 8 puts companyLocation in packages/db/src/repos/location.ts (not repos/map.ts) so it does not wait on Task 7 — cost if wrong: one extra small file.
Wave 1 (parallel): Task 5 (main checkout), Task 6 (wt/t6), Task 7 (wt/t7), Task 8 (wt/t8), Task 10 (wt/t10). Held: Task 9 (needs 7), Task 11 (needs 10), Task 12+ (need 10/11).
Task 6: dispatched (wt/t6, branch f2-t6, BASE 5494fc1, sonnet)
Task 7: dispatched (wt/t7, branch f2-t7, BASE 5494fc1, sonnet)
Task 8: dispatched (wt/t8, branch f2-t8, BASE 5494fc1, sonnet)
Task 10: dispatched (wt/t10, branch f2-t10, BASE 5494fc1, sonnet)
Ruling K (user instruction 2026-10-11): team structure replaces the one-implementer/one-reviewer loop for all later work. Main architects: Architect 1 (controller, Opus) + Architect 2 (Opus agent; writing the F3 plan now, uncommitted, docs/superpowers/plans/2026-10-11-roofline-f3-setup.md). Each task: one Sonnet lead splits it into ≤3 file-disjoint packages for Haiku builders, reviews their code and proposes fixes; an Opus contact (one per 3 leads) approves/amends the fixes; Haiku applies them; ≤3 rounds, then the lead fixes itself; the lead commits. The Opus contact then checks its 3 tasks fit together. Run as a Workflow script. Wave-1 tasks (5, 6, 7, 8, 10, built by Sonnet the old way) get the same Sonnet-review → Opus-check → Haiku-fix pass. Machine: 10 CPUs → ~8 concurrent agents per workflow. Cost if wrong: more fix rounds from Haiku builders.
Task 10: implementer DONE (2759c9e on f2-t10). Notes: tests must import RouterProvider from 'react-router' (two copies under Vitest); extra AuthLayout/formErrors files; public-path guard on 401.
Ruling L: Tasks 11 and 12 build in parallel from f2-t10 @2759c9e (worktrees t11, t12). Task 12 creates a stub apps/web/src/shell/map/MapView.tsx (`export function MapView(props: { onOpen(target: { kind: 'customer' | 'job'; id: string }): void })` rendering an empty `<div data-map-stub />`), and its tests mock that module; at merge Task 11's real MapView wins. Both tasks may add hooks to api/hooks.ts and keys to api/keys.ts; the controller resolves the append conflicts at merge — cost if wrong: one merge conflict.
Team wave A (workflow): group 1 = T10 (review), T11 (build), T12 (build).
Team wave A launched: workflow run wf_5bbf1518-501 (script roofline-team-wf_5bbf1518-501.js under the session workflows/scripts dir) — group 1 (Opus contact 1): T10 review, T11 build (wt/t11 from 2759c9e), T12 build (wt/t12 from 2759c9e).
F3 wave 1 launched (wf_04865695-7fc): F3 T1, T2, T8, T12 in ~/RooflineWork/wt/f3-t*. Team script now lives at .superpowers/sdd/roofline-team.js (parametrized milestone/integrationBranch).
Task 5: implementer DONE_WITH_CONCERNS (f3b43ad on f2-shell). DB suites unverified (machine saturated); ui 154/154; extra review-fixtures.ts helper.
Load incident: load avg 130-215 from ~14 emulated PostGIS test containers (amd64-only image; one testcontainers session 1c5be95e508d, killed runs leave containers). Stopped F3 wave wt8hc2wf4. Added ~/RooflineWork/bin/dbtest (2-slot semaphore under /tmp/roofline-db-slots); team script RULES now require it and forbid touching containers; added 'resume' mode. Removing orphaned containers was denied by the permission classifier → asked the user. Relaunched F3 wave 1 in resume mode: wf_5166646f-a82.
Task 8: implementer DONE_WITH_CONCERNS (46778b0 on f2-t8). Full api/db suite not completed (load). companyLocation in repos/location.ts (Ruling J). It ran `pkill -f "vitest run --project @roofline/api"` once (~12:19), which may have killed a sibling's run.
Task 5 moved to its own worktree for review: wt/t5, branch f2-t5 at f3b43ad (f2-shell already contains f3b43ad; review fixes merge from f2-t5).
Team review group (contact 4): T5, T8.
Team review group launched (contact 4): T5, T8 — run wf_006aac72-c47.
Team wave A done (wf_5bbf1518-501, 42 agents): T10 clean a7fa178 (2 rounds); T11 3790d81 open finding R4-1 (pins are 18px hit targets on phone, need 40px hit layers); T12 c948f3f clean after 3 rounds (window under dock/top bar fixed; 768px top bar overlap fixed). Group check: merge plan in merge-wave-a.md.
Task 10: complete (commits 5494fc1..a7fa178, team review clean)
Task 12: complete (commits 2759c9e..c948f3f, team review clean)
Task 11: complete (commits 2759c9e..3790d81, 1 parked) — Ruling N: R4-1 (40px invisible hit layers for customer/job pins + nearest-feature pick) moves to Task 17 (phone layout owns touch targets) — cost if wrong: phone pin taps miss until Task 17.
Ruling O: a polish task P1 joins team wave 3: lazy-load MapView (bundle 1.4 MB → split), company switch removes non-me queries (old company's pins/search must not linger), StormWindow renders summary only when present, move Bbox type into api/types.ts, auth.test.tsx onto test/helpers.tsx with one timeout source, jsx-quotes prefer-double lint + normalise SearchDialog/UserMenu, keep mapCopy name — cost if wrong: small refactors.
Carry to Task 13: launch Chromium with WebGL (--use-angle=swiftshader --enable-unsafe-swiftshader) so the map summary renders; find banner/summary by text, not bare role=status. Carry to Task 17: --shell-top-inset/--shell-bottom-inset replace hard-coded 72/96/65/94; one fixed inset wrapper; page window under the top bar on phone.
Commit trailers: subagents use their own environment's attribution (Sonnet 5.5) — accepted; controller merge commits carry the Opus line.
Integrated wave A into f2-shell: merges 995fcdc (T10), 05823b9 (T11), 1fb5bd7 (T12); web/ui/shared 447 tests, lint, typecheck, build green. Pushed to private GitHub repo parsasalahshori/roofline (user approved 2026-10-11: create private repo, push all branches, use GitHub Actions + cloud agents). Pushed main, f1-platform-core, f2-shell, f3-setup, f2-t5..t12 (empty f3-t* skipped).
Ruling P: Tasks 14 and 15 are built without their Playwright specs (approvals.spec.ts, today.spec.ts, the shell.spec deep-link extension); those specs are written in the wave after Task 13's stack exists — cost if wrong: e2e coverage arrives one wave later.
Ruling Q: new web feature hooks go in apps/web/src/features/<feature>/api.ts (as the F3 plan's rule 33), not api/hooks.ts, to stop merge conflicts; useCompany lives in features/settings/api.ts (Task 16) and Task 15 reuses it, so Task 15 waits for Task 16 — cost if wrong: one moved import.
Team wave B (contact 5): T14 (wt/t14), T16 (wt/t16) from f2-shell 1fb5bd7. P1 polish → first cloud (remote) agent trial.
CI on GitHub: workflow registered via main commit 46c6e1f (ci.yml with push branches-ignore main + workflow_dispatch; main otherwise untouched); f2-shell 1f2fd00 adds workflow_dispatch; first run 38175178079 on f2-shell. Cloud agents: Agent isolation=remote failed (WorktreeCreate hook returned no path); RemoteTrigger routines here are desktop-bound — not used. Instead: ~/RooflineWork/bin/ci-check (push own task branch, wait for the GitHub run, print failing log). Team script: tasks with "ci": true run ci-check after committing; agents run only focused DB files locally.
Team wave B launched: wf_d7eff59a-acf (contact 5: T14, T16).
CI run 38175178079 (f2-shell): Platform job (lint, typecheck, ALL suites incl. db/api on GitHub) PASSED; v1 job failed — v1/shared/sandbox-properties.ts was committed as an empty blob in 226744a (iCloud checkout reports stat size 0 though the content reads fine, so git stored 0 bytes). Restored via git hash-object from the identical 10,249-byte originals: 0b81e1b, pushed. Only empty tracked file in the tree. Hazard: the main checkout lives in iCloud ~/Documents — consider moving it out.
Task 6: implementer DONE_WITH_CONCERNS (e86e649 on f2-t6): suite run in batches with a private container (load); relative WEB_DIST_DIR resolved to repo root; /api/approvals reads 1 MB before the session gate; signed-out unknown /api path is 401. ci-check now judges the Platform job only.
Team review launched (contact 6): T6 (ci: true) — run wf_79cc1167-5c0.
Task 7: implementer DONE_WITH_CONCERNS (c2173ff on f2-t7): 58 new tests green; full api+db not completed (load); brief's q=lop address expectation corrected (address match is line/city/zip); customerMatch duplicates listCustomers' match; jobs of an archived customer still appear in search and pins; single-address bounds are zero-area.
Task 9: worktree wt/t9 (branch f2-t9) stacked on f2-t7 @c2173ff (needs Task 7's map repo + endpoints).
Team group (contact 7): T7 review (ci) + T9 build (ci).
Team group launched (contact 7): T7 review + T9 build — run wf_017c67f3-e3f. All 5 old-style Sonnet builders (T5, T6, T7, T8, T10) have now reported.
Cloud move (2026-10-11): session continues in a Claude Code cloud container (4 CPUs, no Docker, gh not logged in). ci-check rewritten to use the GitHub REST API via curl; ops/bin/slot caps heavy local commands at 2; team script gains args.cloud, per-task constraints/milestone, and resume-from-WIP-commits (8823dd1). Worktrees under /home/user/wt/<branch>.
Ruling R: the workflow concurrency cap is CPUs-2 = 2 per run, so the four groups run as four parallel workflow runs of the same script (contacts 1-3, 4-6, 7-9, 10-11) instead of one run — cost if wrong: none (same team structure).
Cloud wave launched: group A (T6, T7, T8 review, ci) wf_bc3962a4-08d; group B (T9 resume, T14 resume, T16 review) wf_eddfb3f8-980; group D (F3 T12 resume, T5 review) wf_97a6d639-216.
Ruling S (owner, 2026-10-11: "YES ... as many as u need"): extra cloud sessions run team workflows in their own containers. Siblings push only their task branches, commit their briefs/reports/merge notes on those branches, never touch the ledgers or integration branches, and report back by send_message; the controller merges — cost if wrong: more merge conflicts, resolved at merge.
Sibling 1 (session_01MpVA7xTz6Bus8WPNZWUKRq): F2 T17 phone layout + P1 polish (f2-t17, f2-p1 from f2-shell a246d1a), writes its own T17/P1 briefs; Architect 2 told to skip those two.
Architect 2 briefs written: f2 task-13, task-15, task-18 (deferred Playwright specs); f3 task-3,4,5,6,7,10,11. Its rulings, adopted:
Ruling T (F3): T5 adds US_STATE_NAMES and toUsStateCode to packages/shared/src/address.ts; T7's normalizeState calls it, so T7 waits for T5 and T6 — cost if wrong: T7 waits one wave.
Ruling U (F3): T11 takes a per-SID advisory transaction lock in both /status and applyEarlyDeliveryReports, so a report landing while the send is saved is applied — cost if wrong: one extra lock per report.
Ruling V (F3): T5 exports displayUsPhone; hooks/twilio.ts keeps its private displayPhone until F3 Task 13 — cost if wrong: one duplicated 3-line helper.
Ruling W: T15's only Shell.tsx change is one useTodayAutoOpen() call; T17 keeps that line when it rewrites the shell — cost if wrong: a one-line merge conflict.
Also: T18 scopes the plan's getByRole('dialog').getByText('Done') count to the step list (the stat strip also says Done); T15 adds POST /api/me/today-shown -> {show:false} to SHELL_ROUTES; root e2e script is `npm run e2e -w @roofline/web --`; ci-check takes CI_JOBS="Platform E2E" for T13/T18; F3 T6/T7/T10/T11 tests live in the @roofline/api project and are proven on CI only.
Task 5: team review (group D, contact 10) clean, no fix commits; f2-t5 = f3b43ad already in f2-shell, so no merge. Task 5: complete (5494fc1..f3b43ad). Minors (deferred): 400-char wrap test regex-matches the CSS; awaiting_owner shows waitingForOwner to the owner too (T14 may gate on canApprove); Edit/Retry accessible names are bare.
Cloud group A (wf_bc3962a4-08d, contact 1): T6 83a6b46 (1 round; F1, F2 amended: global parser skips /api/approvals, 1 MB parser after requireSession, signed-out test) CI 38178972637 green; T7 cc05bc8 (1 round; F1-F3 approved: archived customers' jobs hidden from search and pins, customerMatch shared) CI 38179505409 green; T8 46778b0 review clean but no CI run ever started for that sha. Merge notes: ops/sdd/f2/merge-wave-cloud-a.md.
Task 6: complete (5494fc1..83a6b46). Task 7: complete (5494fc1..cc05bc8). Task 8: complete (5494fc1..46778b0; CI proof = f2-shell merge run).
Minors (deferred): APPROVALS_JSON_BODY_LIMIT doc comment garbled (app.ts ~75); single located address gives zero-area bounds - web map must pad when west===east; customerMatch doc comment long line; two 'where is the company' rules (companyLocation company-wide incl. archived vs mapArea rep-scoped) - document, do not unify by accident; weather route queries location before the cache.
Merged into f2-shell: a62343c (T6), 2bee597 (T7), e3b9594 (T8; conflicts in app.ts/config.ts/config.test.ts resolved keeping both sides). typecheck + lint clean.
Fix 96d2c0d: eslint ignores ops/** (roofline-team.js top-level return broke lint on f2-shell since b51c7c1). Sibling 1 told to merge f2-shell into f2-t17/f2-p1.
CI: f2-shell 8d503e9 (T6+T7+T8 merged, lint fix, ops paths-ignore) all green, run 38180364868 — T8's database suites now proven.
Cloud group B (wf_eddfb3f8-980, contact 4): T9 resumed and finished a320599 (showcase lint fix cd6c55e, README dev-seed section, seed-dev test fixes fe82475/a320599) CI 38180250862 green; T14 WIP 66b7ccb found complete, review clean, web 279/279, CI 38177661277 green; T16 57f9715 review clean. Notes: ops/sdd/f2/merge-wave-cloud-b.md.
Task 9: complete (c2173ff..a320599). Task 14: complete (1fb5bd7..66b7ccb; commit title still says wip). Task 16: complete (1fb5bd7..57f9715).
Merged into f2-shell: 29ab813 (T9; README conflict kept both sections), b35c0aa (T14), f711feb (T16). web vitest, typecheck, lint, lint:css clean.
Minors (deferred, to P1 follow-up or T15): T9 seeds sendTime 'Today 10:00 AM' so the screen reads 'Sends Today 10:00 AM' (use 'today at 10:00 AM'); dead 'approvals' ComingSoonKey + copy entry; Review.tsx edit.isPending shared by toggles and text saves; seed-dev non-atomic on showcase failure; toReviewStep isOpen adds canApprove for awaiting_owner (deliberate, matches API).
f2-shell merged into f3-setup (baf4c93): system/index.ts kept both export lists; package-lock.json regenerated with npm install --package-lock-only; typecheck, lint, lint:css and web/shared/ui/send-gate suites clean; no migration-number collision (F2 added none).
Team wave C launched here: T13 (e2e, ci with CI_JOBS="Platform E2E") + T15 (Today), base 26aabec, contact 12 — wf_554eb375-034. Team script gains per-task ciEnv (26aabec).
Architect 2 writing F3 briefs: task 9 first, then 13-24, with proposed groups (status in ops/sdd/f3/briefs-status.txt).
Sibling 1 (session_01MpVA7xTz6Bus8WPNZWUKRq, wf_d3d77fd3-941, contact 21): P1 ed193cf (CI 38180329002 green, review clean) and T17 100e89a (1 round; CI 38180327171 green). Notes: ops/sdd/f2/merge-sib1.md.
Task P1: complete. Task 17: complete. Merged into f2-shell: P1 then T17 (Shell.tsx conflict: lazy/Suspense MapView + T17's tabs/sheet/dock; kept both). web vitest, typecheck, lint, lint:css, build:web clean.
Minors (deferred): a click on a cluster bubble within ~20px of a single pin fires both zoom and the pin card; Vite still warns about the 1,039 kB map chunk.
Carry to T15 (building in wave C on base 26aabec): T17 rewrote Shell.tsx; T15's one useTodayAutoOpen() line merges on top (Ruling W).
Wave C (wf_554eb375-034, contact 12): T13 d6bcc16 (e2e stack + 6 desktop shell specs; CI 38181691899 Platform + E2E green), T15 552d4c5 (Today; web 315; CI 38181682763 green); both reviews clean. Notes: ops/sdd/f2/merge-wave-cloud-c.md.
Task 13: complete (26aabec..d6bcc16). Task 15: complete (26aabec..552d4c5). Merged into f2-shell (Shell.tsx auto-merged onto T17); web vitest, typecheck, lint, lint:css, build:web, playwright --list clean.
Carry to T18: (1) useTodayAutoOpen onSuccess must navigate only if the current path is still '/' (dock click before the POST answers) + unit test; (2) add an e2e for Today auto-open (first visit to / opens /today, Esc, reload, no dialog); (3) markTodaySeen should read the company's timezone, not hard-coded America/Chicago.
Minors (deferred): stack.ts children run via npx (SIGTERM forwarding; spawn detached + kill group); signal handlers registered after DB start; no 'error' listener on children; unused click fixture; brief's playwright-core browsers.json check fails with ERR_PACKAGE_PATH_NOT_EXPORTED (versions match anyway); Today error state and partOfDay boundaries untested.
F2 remaining: T18 (deferred Playwright specs + phone/a11y + acceptance, Ruling AK) then the final whole-branch review.
F2 T18 launched here: wf_3cf9739e-49c (contact 14), base d223d91, ci with CI_JOBS="Platform E2E".
Fix: rep-visibility.test.ts:400 flake (substring 333 in a random UUID; failed f2-shell run 38181409275 on 894f0d2) now matches a whole token; CI paths-ignore adds docs/**. F1 deferred minor closed.
f2-shell 8fcb25f all green (run 38183287222: Platform, E2E, v1). Merged into f3-setup (lockfile regenerated); typecheck, lint, web, playwright --list clean.
Wave D (wf_3cf9739e-49c, contact 14): T18 efa39ff (1 round, F1 approved), CI 38183617238 Platform + E2E green; 20 e2e tests in 5 files, web 344. Edits to demo.ts, seed-demo.test.ts and e2e/fixtures.ts were the controller's carries (in scope). Task 18: complete (d223d91..efa39ff). Merged into f2-shell. f2-acceptance.md CI section updated. Closed minors: sendTime copy, markTodaySeen timezone, Today hijack.
Minors (deferred): POST today-shown marks the day shown even if a dock click beat it (Today never seen that day; fix: acknowledge on open); today.test.tsx formatting churn; a11y spec tags are WCAG 2.0 only (add wcag21a/wcag21aa or fix comment); phone 'Approve stays pinned' may not scroll on a short review; long-name phone test may not render names.
ALL F2 TASKS MERGED (1-18 + P1). Next: the final F2 whole-branch review.
