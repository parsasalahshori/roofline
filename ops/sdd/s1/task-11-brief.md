### Task 11: Storm plan drafting

**Base:** `s1-storm` after Tasks 4, 6 and 10 are merged. Real (F1–F3): agent task creation in `apps/api/src/tasks/service.ts`, `send_sms_batch` (`messaging/send-batch.ts`: **no per-customer render hook today** — Ruling SA), texting registration status (`texting_registrations.campaign_status`). From T10: `shouldDraft`, `alertPlanReady`.

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 `storm/plan.ts` building the five steps; Builder 2 `repos/storm-plans.ts` (recipients: marketing-consented SMS ids, emailable ids, per-recipient fields; replacing a draft task: cancel the old draft's steps and point `company_storms.plan_task_id` at the new one); Builder 3 tests.

**Files:** Fill `apps/api/src/storm/plan.ts`, `packages/db/src/repos/storm-plans.ts`; Test `apps/api/test/storm-plan.test.ts`.

**Interfaces:**
```ts
export async function draftStormPlan(deps, companyId: string, companyStormId: string, now: Date): Promise<{ taskId: string }>
// agent 'storm_scout', kind 'storm_plan', title stormTitle(...), expires now + 48 h, steps in order:
// 1 send_sms_batch { purpose:'marketing', body: settings.storm_sms_template ?? DEFAULT_STORM_SMS, customerIds, fields, dedupePrefix:`storm:${companyStormId}` }  — off with reason when texting isn't approved (F3 registration) or 0 recipients
// 2 send_email_batch { … DEFAULT_STORM_EMAIL_* , dedupePrefix same } — off when storm_email_enabled is false, company has no postal address ('Add your mailing address in Settings → Company'), or 0 recipients
// 3 build_routes { companyStormId, repUserIds: active reps (or owner when none), maxDoors: 1500 } — off when homesHit = 0
// 4 create_ad_campaign google { maxSpendCents: split.google, days, headline/description/keywords from templates } — off when no active google ad_account ('No Google Ads account connected') or split = 0
// 5 create_ad_campaign meta { … primaryText, photoId: newest storm photo or null } — off similarly
// marks company_storms.status 'planned'; calls alertPlanReady
```

**Tests:**
- recipients exclude do-not-contact, archived, informational-only consent (SMS) and opted-out emails; fields per recipient (street and hail size); off reasons; re-draft replaces only a draft; partial approval works through the F2 review (office approves 1–3, the ad steps wait as `awaiting_owner`); expiry 48 h.

**Carries and rulings:**
- **Ruling SA:** `messaging/send-batch.ts` has no per-customer render hook; this task adds one optional `render(customerId) => string` input — the only S1 edit to that file — with `if (!(await lease.keep())) return { status: 'running', result: {} };` still the first statement in the per-customer loop.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): Storm Scout drafts the storm plan — texts, emails, routes and ads`
