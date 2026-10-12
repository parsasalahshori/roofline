# E1 Task 11 report: Sending (Estimator step and link)

Branch e1-t11, commits 43473f9 (feature) and b89c67e (test fix).

## Built
- A-send-proposal: apps/api/src/estimator/send-proposal.ts, proposal-sent.ts, packages/db repos/proposals.ts, tasks/handlers.ts. Link minting (32 random bytes, sha256 hash + encrypted token), draft/step logic, settleSentProposal (idempotent; job lead/inspection -> proposal; replaces earlier unsigned proposal).
- B-messaging: send-batch.ts exports sendOneText (lease line unchanged), dispatcher.ts settles parked send_proposal steps.
- C-routes-shared-tests: routes/proposals.ts (POST /:id/send, GET /:id/link, revise on signed -> 409), shared steps.ts totals per tier (Ruling EL), tests, README env note.

## Review rounds
- Round 1: 1 finding, amended. Round 2: 1 finding, amended. Round 3: 0 findings.

## Minors / judgment calls
- findOpenSendTask reuses draft/awaiting_owner/approved/running tasks; needs_attention is not reused.
- Blocked/failed send returns proposal to draft. Mint generates a token each run and discards it if one is stored.
- sendOneText maps an existing 'queued' row to 'sent'.
- Replace heuristic: latest sent/viewed proposal on same job and customer.

## CI
- Run 38220186315: Platform failed (quiet-hours test used BATCH_AT = 20:30 Omaha, which is allowed hours). Fixed by using 06:00Z (01:00 Omaha).
- Run 38222230303 (b89c67e): Platform and E2E passed.

## Verify tail
typecheck, lint clean; shared 463 passed; web 598 passed.
