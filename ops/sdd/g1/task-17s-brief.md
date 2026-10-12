### Task 17s: Agent rule values — API and the Settings → Agents form (Ruling GX-O)

**Ruling GX-O (track lead):** the plan's Task 17 has two parts. The review previews for the four G1 steps wait for S1's approvals preview registry (Ruling SD) and are built later as Task 17p. This part — the values behind each G1 rule (spec §6 `company_settings` columns, spec §7 "Settings → Agents") — is built now. The plan never gave these columns an API; this task adds one in its own route file rather than editing C1's `routes/company.ts`.

**Base:** `g1-stack` (G1 T3 + T5 + T6 on g1-t3; D1 T4; A1 T3–T11). Real: G1 T1's `company_settings` columns and their CHECKs (`packages/db/src/schema/tenant.ts`, migration `0023`): `claims_nudge_days int[]` {3,5,7}, `weather_rain_pct` 60 (0–100), `weather_gust_mph` 25 (1–100), `reminder_hour` 15 (0–23), `followup_days int[]` {3,4}, `lead_followup_days` 2 (1–30), `review_link` text null, `review_delay_days` 3 (0–30), `followup_reviews`/`followup_leads`/`followup_proposals` bool true. A1's Settings → Agents tab (`apps/web/src/features/settings/AgentsTab.tsx`, owner/office only). C1's settings route style (`apps/api/src/routes/company.ts`: zod `wholeNumber`, `assertKnownFields`, audit `settings.update` with touched fields).

Read first: `ops/sdd/g1/global-constraints.md`, spec §3.3, §4, §5, §6, §7; `routes/company.ts`; `AgentsTab.tsx`; `features/settings/api.ts`; the web copy rules (`apps/web/test/copy-rules.test.ts`).

**Split:**
- Builder 1: `packages/shared/src/agent-values.ts` (+ shared barrel line), `apps/api/src/routes/agent-values.ts`, its mount in `app.ts` (`// G1 Agents`), `apps/api/test/agent-values.test.ts`.
- Builder 2: `apps/web/src/features/settings/AgentRules.tsx` (+ CSS module), the hooks in `features/settings/api.ts`, one mount line at the end of `AgentsTab.tsx`, `apps/web/src/copy/agents.ts` additions (an `agentRules` block).
- Builder 3: `apps/web/test/agent-rules.test.tsx`.

**Shared (`agent-values.ts`):**
```ts
export type AgentValues = { claimsNudgeDays: [number, number, number]; weatherRainPct: number; weatherGustMph: number; reminderHour: number;
  followupDays: [number, number]; leadFollowupDays: number; reviewLink: string | null; reviewDelayDays: number;
  followupReviews: boolean; followupLeads: boolean; followupProposals: boolean };
export const AgentValuesPatch: z.ZodType<Partial<AgentValues>>;   // strict; plain-English messages
```
- Bounds = the DB CHECKs above; `claimsNudgeDays` three whole numbers 1–60 in increasing order; `followupDays` two whole numbers 1–30; `reviewLink` an `https://` URL up to 500 characters, or null (empty string → null). Messages e.g. "Please enter a percent from 0 to 100.", "Please pick an hour from 0 to 23.", "Please enter three numbers of days, smallest first.", "Please enter a web address that starts with https://".

**API (`routes/agent-values.ts`, mounted at `/api/agent-values`):** `GET` → `AgentValues`; `PATCH` (partial) → the new `AgentValues`; both `requireCapability('company_admin')`; unknown fields refused; one audit row `settings.update` with the touched field names (never values); `withTenant` on the company's `company_settings` row.

**Web (`AgentRules.tsx`):** a form section titled "Agent rules" below A1's content on the Agents tab: three groups (Claims: nudge days; Scheduler: reminder hour, rain %, gust mph; Follow-up: the three switches, follow-up days, lead days, review link, review delay). Kit `Field`/`Checkbox`/`Button`; Save shows a toast; field errors under their fields (`ApiError.field`). All strings in `copy/agents.ts` (`agentRules` block, camelCase keys); "Google" may appear only if `copy/agents.ts` is an allowed vendor file — it is not, so say "your review link" (no vendor names). 12px min, AA contrast, keyboard reachable, 40px targets on phone, no horizontal scroll at 375px.

**Tests:** api (CI): GET defaults; PATCH each bound (in/out), order rule for nudge days, review link http refused / https kept / '' → null, unknown field refused, rep and office (office has company_admin? follow `permissions.ts`; the test asserts whatever company_admin allows), audit row with field names. web (local): renders the defaults from a stubbed fetch, saves a changed rain %, shows a field error from a 400 with `field`.

**Verify:** `npx vitest run --project @roofline/web agent-rules copy-rules`, `npm run lint && npm run lint:css && npm run typecheck && npm run build:web` (slot); CI with `CI_JOBS="Platform E2E"`.
- Commit: `feat: agent rule values — API and the Settings → Agents form (G1 Task 17s)`
