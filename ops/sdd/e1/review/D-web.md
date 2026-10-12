# E1 whole-branch review, reviewer D: web, copy, a11y (b1a4980)

Scope: `git diff origin/c1-crm HEAD -- apps/web packages/ui`. packages/ui has no E1 changes. Paths below are under `apps/web/src/` unless they say otherwise. Every finding comes from reading the code against the API routes. None depends on a guess about runtime.

Checked and found clean:
- The homeowner route `/p/:token` sits outside RequireSession and the shell.
- The homeowner page loads no third-party script, sends `credentials: 'omit'` to same-origin `/api/public/...`, and sets noindex.
- Homeowners see totals only, never unit prices.
- The consent text and the estimate clause are imported from CONSENT_TEXT_V1 and ESTIMATE_CLAUSE_V1.
- "Estimate" appears on the measure numbers, option totals, monthly lines, job rows, Today rows and the homeowner totals.
- Corner and add-corner handles are 40px, focusable, and work with arrow keys, Delete, Enter and Space.
- No raw `<button>` and no literal letters in JSX. Text is 12px or larger.
- The Rulings EI and EM hand-off is read defensively and posts `{measurementId, jobId?, customer?}`.
- The request and response shapes of POST/PATCH measurements, POST/PATCH/send/link/revise proposals, tier-templates and estimator settings match the routes.

## Critical

None.

## Important

### I1. A drawn signature that is no longer on screen is still sent and becomes the legal signature image
`features/homeowner/SignFlow.tsx:25,38`, with `packages/ui/src/components/Sheet/Sheet.tsx` ("Renders nothing while closed").
- **What goes wrong:** SignFlow stays mounted on the page while its Sheet unmounts its children on close. The `drawn` state (the PNG) survives the close, but the SignaturePad canvas is remounted blank.
- **How to trigger it:**
  1. The homeowner picks Better, draws a signature and closes the sheet.
  2. They pick Better (or Best) again. The pad is empty.
  3. They type their name and sign.
- **Result:** the old drawing goes out as `drawnSignature`. Ruling EP stores it, hashes it and prints it on the signed PDF's audit page, even though the homeowner saw an empty pad.
- **Fix:** reset `drawn` whenever the sheet opens or the option changes, for example `useEffect(() => { if (open) setDrawn(null); }, [open, optionId])`. Simpler: render `<SignFlow key={chosen.id} …/>` only while `chosen !== null`, so all of its state (drawn, consent, name, the old `sign.error`) starts fresh. The stale error banner after a reopen is fixed by the same change.

### I2. The thank-you page never shows the signed-copy download unless the homeowner reloads
`features/homeowner/HomeownerPage.tsx:221`, `features/homeowner/api.ts:76-77`.
- **What goes wrong:** after a successful sign, the query is invalidated once. The `signed-pdf` job has almost certainly not run yet, so `signed.pdfReady` is false and the page says "Your signed copy is being prepared. Check back in a minute." Nothing asks again: there is no `refetchInterval`, and `refetchOnWindowFocus` is false.
- **Why it matters:** spec §5 says "the homeowner gets a download link on the thank-you page". The e2e test accepts either line, so this is not caught.
- **Fix:** in `usePublicProposal`, add `refetchInterval: (q) => (q.state.data?.status === 'signed' && q.state.data.signed?.pdfReady === false ? 5000 : false)`, with a cap of about 2 minutes if wanted.

### I3. The Estimator window lists only the 50 newest proposals of any status
`features/estimator/EstimatorWindow.tsx:27` (`useProposals({})`); see `packages/db/src/repos/proposals.ts:254` (`clampPage`, DEFAULT_PAGE_SIZE 50, newest created first).
- **What goes wrong:** the "To review", "Out with customers" and "Signed" groups are filtered on the client from one unpaged request. That request returns the first 50 rows across every status, including replaced, declined and expired ones.
- **How to trigger it:** a company that has made more than 50 proposals. Older drafts, ready proposals and proposals still out with customers silently disappear from the window, with no "more" control.
- **Also:** spec §6 lists Declined and Expired groups and a search by name or address, and neither exists.
- **Fix:** query per group with the server's `status` filter (one `useProposals({status})` per status, or let the route accept several statuses), and show `total` with a "Show more" control using `offset`.

### I4. Price-changing measure edits can race "Make proposal", so the proposal is priced on the old pitch or buildings
`features/measure/MeasureWindow.tsx:174-185` and `:206`.
- **What goes wrong:** pitch and building toggles save with a fire-and-forget `patch.mutate`. Only the outline and overhang go through the `pending` and `flushPending` path. `makeProposal()` awaits `flushPending()`, which resolves at once when only a pitch or building PATCH is in flight. It then POSTs `/api/proposals` alongside that PATCH.
- **How to trigger it:** tap a pitch (for example 8/12), then tap Make proposal straight away on a slow connection. The build transaction can read the measurement before the PATCH commits. The draft is then priced on the previous pitch, while the window showed 8/12 and its numbers.
- **Fix:** route `choosePitch` and `toggleStructure` through `pending.current` and `flushPending` (no debounce needed), or keep the promise of the last `mutateAsync` and await it in `makeProposal` and before the exact-report request. Also disable Make proposal while `patch.isPending`.

### I5. Declined and expired proposals cannot be revised from the proposal window, and signed ones are told to revise
`features/proposals/ProposalWindow.tsx:69,83`.
- **What goes wrong:** `canRevise` covers only `sent | viewed | ready`. Ruling EJ says declined and expired proposals may still be revised, and the API allows it (`routes/proposals.ts` `/revise` refuses only signed).
- **How to trigger it:** a homeowner taps "Not right now". The rep opens the declined proposal and sees "This proposal was sent. Make a revised proposal to change it." There is no revise button.
- **Signed proposals:** they show the same banner, but revising a signed proposal is refused with 409 "This proposal is signed. Make a new proposal for more work."
- **Fix:**
  - Set `canRevise = ['sent','viewed','ready','declined','expired'].includes(status)`.
  - Choose the banner by status: for `signed`, use the API's SIGNED_PROPOSAL_MESSAGE wording; for `ready`, see M1.

## Minor

### M1. A 'ready' proposal (waiting for the send approval) is a dead end, and its "Copy link" always fails
`features/proposals/ProposalWindow.tsx:83,135-144`.
- **What goes wrong:** for `ready`, the window hides Send, ignores `proposal.taskId` (the waiting approval), and shows "This proposal was sent…" although nothing was sent. "Copy link" is shown for every status other than draft. For `ready`, `/link` answers 409 "Send the proposal first, then you can copy its link.", but `useCopyLink` toasts the generic "We couldn't copy the link."
- **Fix:**
  - For `ready`, show a "Waiting for your OK" link to `/approvals/${proposal.taskId}`, with its own banner text.
  - Show Copy link only for sent, viewed, signed, declined and expired.
  - In the `onError` of `useCopyLink`, `useSendProposal` and `useReviseProposal` (`features/proposals/api.ts:74,93,110`), toast the server's message the way `usePatchProposal` does (`messageOf`).

### M2. "Get exact report" is offered when it cannot or should not be used
`features/measure/MeasureWindow.tsx:339-355`. Each click creates a new priced order and spend task (`apps/api/src/estimator/exact-report.ts`, no per-measurement guard).
- **Reps:** the button shows for reps, though the API answers 403 and spec §6 says owner and office only. The rep then gets "We could not ask for the report."
- **Exact measurements:** the button also shows on a measurement that is already `kind: 'exact'`.
- **After a remount:** once the window remounts, the button returns even though a request already exists, so a second paid-report task can be drafted for the same roof.
- **Fix:** hide the button for `role === 'rep'` and when `m.kind === 'exact'`. Server-side de-duplication of open orders is reviewer B's call.

### M3. A locked measurement still lets the outline be dragged, nudged and deleted
`features/measure/MeasureWindow.tsx:144` and `OutlineEditor.ts`.
- **What goes wrong:** pitch, overhang and buildings are disabled when `locked`, but the outline editor is created with no lock.
- **Result:** dragging a corner on a measurement behind a sent proposal recomputes "The numbers" on screen. The PATCH then gets 409, so the numbers no longer match the sent proposal.
- **Fix:** pass `readOnly` to `createOutlineEditor` (no handles, or handles without listeners) when `m.locked`. Also disable "Start over" when locked.

### M4. Deleting corners down to two leaves no way to add one back
`features/measure/OutlineEditor.ts:331,386`.
- **What goes wrong:** Delete, Backspace or a long-press removes a corner with no lower limit. With 2 corners, `rebuildHandles` makes no add-corner handles (they need `ring.length >= 3`), and draw mode cannot be re-entered from the UI. The rep sees "Add at least three corners." but has no means to do it, short of leaving the page.
- **Fix:** refuse a delete that would leave fewer than 3 corners, or keep add-corner handles for 2 points, or offer "Start over" (`setDrawMode(true)`) whenever `problem === 'too_few_corners'`.

### M5. The financing form accepts values the API refuses
`features/settings/FinancingSection.tsx:58,69` and `copy/financeEstimate.ts`.
- **What goes wrong:** the web allows APR 0–100% and terms of 1–600 months, and the help text says so. The API (`routes/estimator-settings.ts` RULES) allows `financingAprBps` 0–5000 (50%) and `financingTermMonths` 1–360.
- **Result:** an APR of 60, or a 480-month term, passes the client check and comes back as "Please check this field."
- **Fix:** use 0–50 and 1–360 in `parse()`, in `aprRange`/`termRange`, and in the inputs' `max`.

### M6. A failed sign never refreshes the page underneath
`features/homeowner/api.ts` `useSignProposal`.
- **What goes wrong:** on 409 ("This proposal is already signed." when a co-owner signed on another phone, or "This proposal has expired.") or 410, the sheet shows the message, but the page behind it keeps offering options until a reload.
- **Fix:** in `onError`, invalidate `publicProposalKey(token)` when `status` is 409 or 410.

### M7. Make proposal hides the server's reason
`features/estimator/MakeProposal.tsx:56` and `features/measure/MeasureWindow.tsx:217`.
- **What goes wrong:** every failure in measure, build or send shows "We could not make the proposal. Please try again." The API answers plain, actionable messages here, such as the 403 "role cannot" for a rep on someone else's job, or the 409 measurement or proposal state. Trying again cannot help in those cases.
- **Fix:** keep the caught `ApiError` and show its `message`, falling back to `makeFailed`.
