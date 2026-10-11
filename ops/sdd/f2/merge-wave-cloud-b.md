important [14]: f2-t14's only commit (66b7ccb) is titled 'wip(f2-t14): unfinished team work, saved for the move to the cloud'. There is no later commit that finishes it or records a review fix, unlike T9, whose wip commit 0571e78 is followed by lint and test fixes. The diff looks complete (list, review, edit and Not now sheets, polling, router, tests), but the commit message itself says the work is unfinished.
 -> Before merging, confirm with the T14 implementer or controller that T14 is complete and verified: the web vitest project, typecheck, lint and lint:css all pass on f2-t14, run through /home/user/roofline/ops/bin/slot. If anything is left, finish it with a proper commit, not the wip one.

minor [9,14]: T14's review screen depends on what T9 adds. editableText() offers Edit for a demo_message only when payload.sample is a string. The PATCH it sends is {...payload, sample}, and at base the demo_message schema is strictObject({label}), so the server would reject it. Only T9 adds sample, recipientCount and sendTime to that schema, and seeds them. Without T9, the demo plan shows no message sample, no recipient line and no Edit button. The interfaces line up: T9's preview fills messageSample, recipientCount and sendTime, which StepPreview already has, and T14 passes step.preview straight to ReviewStep.
 -> Merge T9 before or with T14 on f2-shell, so the end-to-end demo (seed:dev, then /approvals/<id>) shows the sample and the edit flow. Nothing in the code needs to change.

minor [9,14]: Copy mismatch: T9 seeds sendTime: 'Today 10:00 AM', and T14 renders it as review.sendTime(when) => `Sends ${when} · quiet hours respected`. The screen then reads 'Sends Today 10:00 AM', with a capital T mid-sentence.
 -> Change T9's seed to sendTime 'today at 10:00 AM' (also in the showcase and seed-demo tests that assert it), or have T14's copy handle the case. This is cosmetic and can be a follow-up.

minor [14]: After T14, no route renders comingSoon.approvals, yet 'approvals' is still in ComingSoonKey (shell/apps.ts) and the entry is still in copy/comingSoon.ts. It is dead copy. Knip or lint might not catch it, because it is a property of an object, not an unused export.
 -> Optional cleanup in a follow-up: drop 'approvals' from ComingSoonKey and its comingSoon entry. 'storm' must stay, because storm/* still uses comingSoonWindow.

All three branches are on the f2-shell line. 1fb5bd7 (base of T14/T16) and c2173ff (base of T9) share merge-base 5494fc1, and both commits are already on origin/f2-shell. I ran `git merge-tree --write-tree` on every pair (T14+T16, T14+T9, T16+T9) and none of them conflicted.

The only file two branches both edit is apps/web/src/app/router.tsx (T14 and T16), and git merges it automatically. The merged result has:
- T16's `Navigate` added to the react-router import on line 1.
- T14's ApprovalsList and ReviewRoute imports.
- T16's Settings import.
- T14's approvals, approvals/:taskId and storm/plans/:taskId routes.
- T16's settings redirect and settings/:tab routes, with the trailing comment 'Task 15 adds today; until then it shows this', which is correct.

I checked that merged file and it is correct as merged.

T9 touches no apps/web files, so it cannot conflict with T14 or T16 on the web side. Its shared change (packages/shared/src/steps.ts, which adds optional sample, recipientCount, sendTime and area) only adds fields. The web gets StepView and StepPreview from the base types, and T14 already reads them.

Overlap between the branches:
- No duplicated helpers. T14 has features/approvals/api.ts and T16 has features/settings/api.ts. Both use the existing keys.ts entries (task, approvals, summary, company, team) and neither adds new keys.
- No shared copy files. T14 adds copy/approvals.ts and copy/review.ts. T16 adds copy/settings.ts and reuses connections, billing and setup `.later`.
- Both follow the rules: text comes from copy, there is no raw <button> (T16 uses the ui Button with href), and relative imports use .ts/.tsx.
- T14 changes the existing shell.test.tsx and auth.test.tsx; T16 only adds new test files. The existing user-menu test expects /settings/company, which T16's route now serves.

Suggested order: T9, then T14, then T16 (any order merges cleanly). Putting T9 first means the demo plan has the message sample that T14's Edit flow needs.

After merging, run on the f2-shell integration checkout, through /home/user/roofline/ops/bin/slot:
- the web vitest project
- typecheck
- lint
- lint:css

T9 includes database-backed tests (apps/api/test/seed-dev.test.ts, showcase.test.ts, seed-demo.test.ts) and changes to packages/db/testing. These cannot run here; let CI run them through ops/bin/ci-check.
