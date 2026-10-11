# SDD ledger — plan: docs/superpowers/plans/2026-10-11-roofline-f3-setup.md

F3 on branch f3-setup (7b4e8b4, stacked on f2-shell 5494fc1). Team structure per Ruling K (F2 ledger). Task worktrees ~/RooflineWork/wt/f3-t<N>.
Team wave F3-1 (workflow): T1, T2, T8 (Opus contact 2), T12 (Opus contact 3).
Team wave F3-1 launched: run wf_04865695-7fc (script .superpowers/sdd/roofline-team.js in the main checkout). Contact 2: T1, T2, T8; contact 3: T12.
Relaunched in resume mode: wf_5166646f-a82 (dbtest slots).
Cloud wave launched (2026-10-11): group C (T1, T2, T8 resume, ci) wf_4bc5b561-f71; T12 resumes in group D wf_97a6d639-216 (with F2 T5). See F2 ledger Ruling R.
Group C (wf_4bc5b561-f71, contact 7): T1 4e6971a, T2 3d92b01, T8 0466b73 were already complete in their WIP commits; review round 1 clean for each; CI platform job green (runs 38177661443, 38177661487, 38177661881). Commit messages stay "wip(...)" (pushed history is not rewritten).
Task 1: complete (7b4e8b4..4e6971a). Task 2: complete (7b4e8b4..3d92b01). Task 8: complete (7b4e8b4..0466b73).
Carry to Task 3: when USAGE_KINDS moves to packages/shared/src/billing.ts, replace the db enums.ts UsageKind with `export { USAGE_KINDS, type UsageKind } from '@roofline/shared'` (contact 7).
Minors (deferred): recordUsage sets createdAt/updatedAt from input.at; GIN indexes not CONCURRENTLY; insertInboundText has no ON CONFLICT for messages_inbound_sid_uniq (decide in Task 10); revokeDataApiExposure functions revoke not 42501-guarded; revokeOnPgboss 42501 skip not logged; preflight script prints raw stack on connect failure; send() unknown-failure message hard-coded.
Merged into f3-setup: fb3db4c (T1), a23bf2a (T2), d629c74 (T8); typecheck clean; pushed; CI confirms T1+T2 together (contact 7's note).
Sibling 2 (session_01NbXKpWjMvEQwTqNmQCt6wp): F3 T3, T4, T5 from f3-setup d629c74 (contacts 31-33); reports + merge notes on branch ops-sib2.
Sibling 3 (session_01RypesnL2fbawyJH5HtdS7E): F3 T6, T10 from f3-setup d629c74, then T11 stacked on f3-t10 (contacts 41-44); reports + merge notes on branch ops-sib3.
Held for the controller: T7 (needs T5 + T6, Ruling T); T9 API skeleton (needs F2 T6-T9 in f2-shell, then f2-shell into f3-setup).
