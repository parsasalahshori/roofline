### Task 16: Web — Claim section on jobs and the claims board

**Base:** `g1-t16` = `g1-stack` (G1 T3, T5, T6) merged with `g1-mc1` (g1-agents + c1-crm 903047f: C1's real job window). Real: T6's API `GET/PUT /api/jobs/:jobId/claim` → `JobClaimResponse` (`{ claim: ClaimView | null; intake: ClaimIntakeView | null }`), `GET /api/claims?status=` → `ClaimBoardRow[]`, types and `CLAIM_FIELD_LIMITS` in `packages/shared/src/claims.ts`; `CLAIM_STATUSES` (`more-agents.ts`); C1's `apps/web/src/features/job/JobSections.tsx` (`Section` component, sections appointments/quotes/tasks/timeline); A1's `apps/web/src/features/agents/AgentPage.tsx` (`/agents/:agent`, `agent` is a `PageAgent`, `claims` among them). **[T7]** the claim packet (build/download) is not built yet: the section shows the packet line only when the API says a packet exists (it never does yet) and has no build button until Task 7 (leave a `// G1 Task 7` comment where the button goes).

Read first: `ops/sdd/g1/global-constraints.md`, `ops/sdd/g1/progress.md` (Ruling GX-C), spec §3.1, §7; `JobSections.tsx`, `JobWindow.tsx`, `features/job/api.ts` (`useJobView`, `jobKey`), `AgentPage.tsx`, `copy/job.ts`, the F2 web rules (copy files, kit components, no raw `<button>`, a11y limits).

**Ruling GX-C:** `ClaimSection.tsx` is new; `JobSections.tsx` gets exactly one added import and one `<ClaimSection jobId={…} />` line (after the quotes section); nothing else in `features/job/`. The claims board goes in `features/agents/ClaimsBoard.tsx` and `AgentPage.tsx` gets one import and one line: `{agent === 'claims' && <ClaimsBoard />}` below the rules section.

**Split:**
- Builder 1: `features/claims/api.ts` (hooks), `features/job/ClaimSection.tsx` (+ CSS module), the `JobSections.tsx` line, `copy/claims.ts` (new copy file; no vendor names; camelCase keys; status labels as plain words).
- Builder 2: `features/agents/ClaimsBoard.tsx` (+ CSS module) and the `AgentPage.tsx` line.
- Builder 3: `apps/web/test/claim-section.test.tsx`, `apps/web/test/claims-board.test.tsx`.

**Hooks (`features/claims/api.ts`):** `useJobClaim(jobId)` (query `['claim', jobId]`), `useSaveClaim(jobId)` (PUT; on success set the query data and invalidate `jobKey(jobId)` so the timeline refreshes), `useClaimsBoard(status?)` (query `['claims-board', status ?? 'all']`).

**Claim section:** title "Insurance claim". No claim and no intake → a line "No claim on this job yet." and a ghost button "Add claim details". With an intake and no claim → "From the Front Desk call: <insurer>, claim <number|not given>" and "Add claim details" (opens the form pre-filled from the intake). With a claim → a status chip (plain words: Not filed, Filed, Adjuster visit booked, Inspected, Approved, Partly approved, Denied, Supplement asked for, Closed), the fields that are set (insurer, claim number, date of loss, adjuster name, adjuster phone shown via `displayUsPhone`, adjuster email, deductible as dollars), notes, an "Edit" button, and a short history list ("Filed · by Sam · Oct 12", "Inspected · by the Claims agent · Oct 14"). The form (a kit Sheet or inline form, like `EditJobSheet.tsx`): every editable field, the status as a Select, deductible in dollars → cents, Save/Cancel, field errors under their fields from `ApiError.field`, a toast on save. The adjuster's phone and email are shown as text only: no tel:/mailto: links and no "text the adjuster" action (plan constraint: nothing addresses an insurer or adjuster).

**Claims board (`ClaimsBoard.tsx`):** under the Claims agent's page: columns by status in `CLAIM_STATUSES` order, each a list of cards (customer, address, insurer, claim number, "since Oct 12"); a card links to the job (`/jobs/:id`). Empty → "No claims yet." On a phone (≤ 600px) the columns stack.

**Tests (local, stubbed fetch through `./helpers.tsx`):** section with no claim; with an intake (pre-fill); with a claim (status words, history line, phone formatted, no `tel:` link); saving sends only the changed fields and shows the toast; a 400 with `field: 'claimNumber'` shows under that field; board renders columns in order and a card links to the job; empty board text. Keep the copy-rules test green.

**Verify:** `npx vitest run --project @roofline/web claim copy-rules`, `npm run lint && npm run lint:css && npm run typecheck && npm run build:web` (slot); CI with `CI_JOBS="Platform E2E"`.
- Commit: `feat(web): claim section on jobs and the claims board (G1 Task 16)`
