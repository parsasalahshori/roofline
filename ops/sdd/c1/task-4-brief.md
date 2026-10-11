### Task 4: Shared view types and CSV writing

**Base:** `c1-crm` after Task 1 is merged (Tasks 2 and 3 run beside this one; import their types by name — `BoardStage` from `pipeline.ts`, `WorkHours` from `availability.ts` — and if a sibling has not merged yet, the lead stubs the missing type in a scratch commit and drops it at merge). From `@roofline/shared`: `JobStage`, `JobSource`, `CustomerSource`, `ConsentStatus`, `TaskStatus`, `MessageStatus`, `ActivitySubjectType` (`enums.ts`), `Pricebook`, `Scope`, `Calculation` (`pricing.ts`), the Task 1 constants in `availability.ts`.

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

**Split:** Builder 1 `crm.ts`; Builder 2 `csv.ts`; Builder 3 the tests.

**Files:**
- Modify: `packages/shared/src/crm.ts`, `packages/shared/src/csv.ts`
- Test: `packages/shared/test/csv.test.ts`, `packages/shared/test/crm-types.test.ts` (type-level checks with `expectTypeOf`)

**Interfaces (`crm.ts`, types only — the API returns exactly these, the web reads them):**
```ts
export type MemberRef = { userId: string; name: string };
export type JobCard = { id: string; customerId: string; customerName: string; propertyId: string; addressLine: string; stage: JobStage;
  valueCents: number | null; assigned: MemberRef | null; daysInStage: number; stuck: boolean; nextStep: string | null; nextStepOn: string | null; updatedAt: string };
export type BoardColumn = { stage: BoardStage; count: number; totalCents: number | null; jobs: JobCard[] };
export type BoardView = { columns: BoardColumn[]; lost: { count: number } };
export type HomeSummary = { id: string; addressLine: string; city: string; state: string; zip: string; located: boolean; jobs: { id: string; stage: JobStage }[] };
export type AppointmentView = { id: string; kind: AppointmentKind; title: string; status: AppointmentStatus; startsAt: string; endsAt: string; allDay: boolean;
  assigned: MemberRef | null; jobId: string | null; customerId: string | null; customerName: string | null; propertyId: string | null; addressLine: string | null;
  notes: string | null; source: AppointmentSource; sync: 'none' | 'synced' | 'pending' | 'failed'; canEdit: boolean };
export type QuoteSummary = { id: string; number: string; status: QuoteStatus; totalCents: number; updatedAt: string };
export type JobView = { job: JobCard & { source: JobSource; lostReason: string | null; stageChangedAt: string; archived: boolean; createdAt: string };
  customer: { id: string; displayName: string; phone: string | null; email: string | null };
  home: HomeSummary; appointments: AppointmentView[]; quotes: QuoteSummary[]; tasks: { id: string; title: string; status: TaskStatus }[];
  can: { edit: boolean; seeValue: boolean; archive: boolean } };
export type CustomerView = { customer: { id: string; displayName: string; firstName: string | null; lastName: string | null;
  phones: { e164: string; label: string | null; primary: boolean }[]; emails: string[]; tags: string[]; consent: ConsentStatus; doNotContact: boolean;
  source: CustomerSource; archived: boolean; createdAt: string };
  homes: HomeSummary[]; jobs: JobCard[]; upcoming: AppointmentView[]; can: { edit: boolean; changeConsent: boolean; archive: boolean } };
export type TimelineItem = { id: string; at: string; type: 'activity' | 'text'; kind: string; summary: string;
  actor: { type: 'user' | 'agent' | 'system'; name: string | null }; subject: { type: ActivitySubjectType; id: string };
  text: { direction: 'in' | 'out'; body: string; status: MessageStatus } | null };
export type TimelinePage = { items: TimelineItem[]; nextBefore: string | null };
export type TodayView = { appointments: AppointmentView[]; followUps: JobCard[] };
export type CalendarConnectionView = { provider: CalendarProvider | null; status: CalendarConnectionStatus | null; accountEmail: string | null;
  calendarId: string | null; calendarName: string | null; lastSyncedAt: string | null; configured: Record<CalendarProvider, boolean> };
export type ScheduleSettings = { workHours: WorkHours; travelBufferMinutes: number; minNoticeMinutes: number; stuckAfterDays: number };
export type PricebookView = { prices: Pricebook; defaults: QuoteDefaults; isExample: boolean };
export type QuoteDefaults = { wastePercent: number; markupPercent: number; taxPercent: number; material: Scope['material'] };
export type QuoteMeasurement = { source: 'manual'; areaSqFt: number; areaType: 'surface' | 'footprint'; pitch: number; notes: string | null };
export type QuoteView = { id: string; jobId: string; number: string; status: QuoteStatus; measurement: QuoteMeasurement; scope: Scope; prices: Pricebook;
  calculation: Calculation; notes: string | null; validUntil: string; createdAt: string; finalizedAt: string | null; canEdit: boolean };
```
(`CalendarProvider` here is the shared type from `CALENDAR_PROVIDERS`; the API's provider *interface* in Task 5 is named `CalendarApi` to avoid the clash.)
- **`csv.ts`:**
```ts
export function csvCell(value: string | number | boolean | null | undefined): string;   // '' for null; formula guard (=,+,-,@,\t,\r → leading '); RFC 4180 quoting
export function toCsv(headers: readonly string[], rows: readonly (readonly (string | number | boolean | null | undefined)[])[]): string;   // CRLF, trailing CRLF
```

**Tests:**
- `csvCell('=SUM(A1)') === "'=SUM(A1)"`, `csvCell('+1 402') === "'+1 402"`, `csvCell('Lee, "Ann"') === '"Lee, ""Ann"""'`, `csvCell('-5')` guarded, `csvCell(5)` → `'5'` (numbers are not guarded), `toCsv` line endings; type-level: `expectTypeOf<BoardView['columns'][number]['stage']>().toEqualTypeOf<BoardStage>()`.

**Carries and rulings:**
- `CalendarProvider` is the shared `'google' | 'microsoft'` type; the API interface is `CalendarApi` (Ruling 5).

**Verify notes:**
- `npx vitest run --project @roofline/shared` → PASS.
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); still confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(shared): CRM view types and formula-safe CSV`
