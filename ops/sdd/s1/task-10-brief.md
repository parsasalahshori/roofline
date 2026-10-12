### Task 10: Alerts and the settle trigger

**Base:** `s1-storm` after Task 9 is merged. Real (F3): `Mailer` (`{ to, subject, text }`), `company_members` view (role, status), `memberships.storm_alert_email` (T1). From T9: `matchCompany`.

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 `storm/alerts.ts` (emails through `Mailer` to owner/office members with `storm_alert_email`, in-app entries); Builder 2 `storm/settle.ts` (the draft trigger: final, or 90 minutes since `last_grew_at`; re-draft on growth when the plan is still a draft) wired after `matchCompany`; Builder 3 `hail-health` schedule (stale banner data and the ops email when the newest run is > 3 hours old during April–September, > 12 hours otherwise) and tests.

**Files:** Fill `apps/api/src/storm/{alerts,settle}.ts`, `jobs/scheduler/hail-health.ts`; Modify `apps/api/src/storm/match.ts` (call `afterMatch`); Test `apps/api/test/storm-alerts.test.ts`.

**Interfaces:**
```ts
export async function alertNow(deps, companyId, companyStormId): Promise<void>;     // once per storm (company_storms.alerted_at claim)
export async function alertPlanReady(deps, companyId, companyStormId, taskId): Promise<void>;
export function shouldDraft(cs: { status; planTaskId; planStatus: 'draft' | 'other' | null }, storm: { status; lastGrewAt }, now: Date, grownSinceDraft: boolean): 'draft' | 'redraft' | 'wait' | 'skip'
// Email copy (copy constants in storm/alerts.ts): subject 'Hail near Omaha, NE — up to 1.25" (radar-estimated)'; body with counts and a link to /storm/<id>
```

**Tests:**
- one "now" email per storm even across ten matches; members with alerts off get none; reps get none; settle at final; settle at 90 minutes; growth before approval → `redraft`; after approval → `skip`; health thresholds by month.

**Carries and rulings:**
- One "now" alert per storm per company, claimed by `company_storms.alerted_at`.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): storm alerts by email and in-app, and drafting when the storm settles`
