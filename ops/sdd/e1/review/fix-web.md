# E1 review fixes: web (branch e1-rev-web)

All fixed, test-first, in apps/web (src and test). Nothing under features/homeowner, apps/api or packages touched.

- D-I3 fixed. `useProposalGroup(statuses, q)` (estimator/api.ts) is an infinite query: one `GET /api/proposals?status=&q=&offset=` per status of a window group, 50 per page (server page size), `hasNextPage` while any status has more. Groups: To review (draft, ready), Out with customers (sent, viewed), Signed, Declined, Expired. "Show more" per group; a search box (`q`, debounced 250 ms, max 100). Tests: estimator.test.tsx (groups, Declined/Expired, paging 50+10, search q).
- D-I4 fixed. Pitch and building edits go through `pending` + `flushPending`; flushes are chained (`inflight`), and a flush with nothing new awaits the saves in flight, so Make proposal and Get exact report wait for every PATCH. Make proposal is disabled while `patch.isPending` or after a failed save. Tests: measure.test.tsx (waits for a slow pitch PATCH, building toggle saves at once).
- D-I5 fixed. Revise offered for sent, viewed, ready, declined, expired; banner by status via `proposals.noteFor` (signed: final, no revise; ready/declined/expired own text). New copy keys readyNote, waitingForOk, signedNote, declinedNote, expiredNote, noteFor. Tests: proposals.test.tsx.
- D-m1 fixed. Ready proposal: banner with a link to `/approvals/<taskId>`; Copy link only for sent, viewed, signed, declined, expired; send, copy-link and revise hooks toast the ApiError message (fallback copy kept). Tests: proposals.test.tsx (ready, revise 409, link 409, send 409).
- D-m2 fixed (web side). Get exact report only for owner/office (useMe) and never when `kind === 'exact'`; after a request it shows the link to the approval (the API dedupes across remounts). Tests: measure.test.tsx (rep, exact).
- D-m3 fixed. `createOutlineEditor` has `readOnly` and `setReadOnly()`: no handles, no drag, no draw. The window passes `locked` (including a 409 on save) and hides the redraw button. Tests: locked window has no handles; a 409 turns the outline read-only.
- D-m4 fixed. `deleteCorner` refuses a delete at 3 corners (`refused: true`, problem `too_few_corners`; the ring and the pending save stay as they were); keyboard and long press both go through it. A "Draw the outline again" button (`measure.redraw`) re-enters draw mode. Tests: reducer, Backspace on a 3-corner ring, redraw.
- D-m5 fixed. Financing accepts APR 0-50 and term 1-360 (parse, input max, aprRange/termRange copy). Test: settings-estimator.test.tsx.
- D-m7 fixed. `makeFailureMessage()` shows the server's message for 400, 403 and 409 in MakeProposal and the measure window; otherwise `makeFailed`. Tests: estimator.test.tsx (403), measure.test.tsx (409).

Note: the replaced status no longer shows the "was sent" banner (only the replaced-by banner).
