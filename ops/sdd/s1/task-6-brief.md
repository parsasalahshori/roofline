### Task 6: Step types and the email gate

**Base:** `s1-storm` after Task 1 is merged. Real (F3): `packages/shared/src/steps.ts` (`STEP_TYPES`, `stepTypes`, `send_sms_batch` payload `{ purpose, body, customerIds ≤ 5000, dedupePrefix? }`, `MARKETING_TEXT_MESSAGE`), `packages/send-gate/src/{decide,quiet-hours,index}.ts` (`decide`, `GateDecision`, `nextAllowedTime`), `GATE_RULES`.

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 `send_email_batch`, `build_routes`, `create_ad_campaign` in `steps.ts`, plus the `fields` extension to `send_sms_batch`; Builder 2 `packages/send-gate/src/email.ts` (`decideEmail`); Builder 3 tests. Step validation uses only constants from `storm.ts` written in Task 1 (no Task 4 logic), so Tasks 4 and 6 run side by side.

**Files:** Modify `packages/shared/src/steps.ts`, `packages/send-gate/src/index.ts`; Create `packages/send-gate/src/email.ts`; Test `packages/shared/test/steps-storm.test.ts`, `packages/send-gate/test/email.test.ts`.

**Interfaces:**
```ts
// send_sms_batch gains an optional per-recipient field map (backward compatible):
//   fields?: Record<customerId, Record<string, string>>  (≤ 5000 keys; values ≤ 60 chars) — rendered by renderStormTemplate before the gate; send-batch.ts already renders per customer, Task 11 passes the map through its existing render hook (if send-batch has no hook, Task 12 adds a one-line `renderFor(customerId)` option — Ruling 6)
send_email_batch: { approvalClass: 'message'; payload: { purpose: 'marketing'; subject: string; body: string; customerIds: string[] /* ≤ 5000 */; fields?: Record<string, Record<string,string>>; dedupePrefix?: string; companyStormId?: string } ; preview → { title: 'Email {n} customers', lines, messageSample, recipientCount, sendTime } ; minutesSaved: min(0.5 × n, 120) }
build_routes: { approvalClass: 'internal'; payload: { companyStormId: string; repUserIds: string[] /* ≥ 1 */; maxDoors: number /* ≤ 1500 */ } ; preview → { title: '{routes} door-knock routes · {doors} doors', lines: per rep } ; minutesSaved: 120 × routes }
create_ad_campaign: { approvalClass: 'spend'; payload: { companyStormId: string; platform: 'google' | 'meta'; maxSpendCents: number /* 500–1,000,000 */; days: number /* 1–30 */; headline: string; description: string; keywords?: string[] /* google */; primaryText?: string /* meta */; photoId?: string | null } ; preview → { title: 'Google ads on the hail area' | 'Facebook and Instagram ads on the hail area', lines: [circles, '$X a day for N days'], maxSpendCents } ; minutesSaved: 45 }
// send-gate/email.ts
export type EmailGateRequest = { purpose: 'marketing' | 'informational'; billingOk: boolean; email: string | null; doNotContact: boolean; optedOut: boolean;
  subject: string; body: string; companyName: string; companyAddress: string | null; dedupeHit: boolean; sentLast7Days: number; now: Date; timeZone: string };
export type EmailGateDecision = { ok: true; sendAt: Date } | { ok: false; rule: GateRule; reason: string };
export function decideEmail(r: EmailGateRequest): EmailGateDecision;   // rule order and messages: spec §5.2; reuses GATE_RULES names (billing, contact, content, dedupe, frequency, quiet_hours); 'Email is paused until billing is sorted out.', 'No email address on file.', 'They unsubscribed from emails.', 'Emails need the company name, mailing address and unsubscribe link.', 'Already emailed about this.', 'Already got 2 emails this week.'; quiet hours → ok with a later sendAt (nextAllowedTime)
```

**Tests:**
- each step validates (counts, ranges, Google needs keywords, Meta needs primaryText); previews read as specified; `create_ad_campaign` preview carries `maxSpendCents`; `decideEmail` rule order table; marketing email without a postal address → `content`.

**Carries and rulings:**
- `send-gate/src/index.ts` and `shared/steps.ts` are edited only here in S1.
- The plan's `fields` addition to `send_sms_batch` is optional and backward compatible.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(shared,send-gate): storm step types and the email gate`
