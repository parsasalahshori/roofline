# Task 17 report: Web proposal view and editing (e1-t17, e4f67d2)

## Built
- A-option-card: OptionCard.tsx/.module.css, proposal-option-card.test.tsx. Live priceTier pricing, waste/markup clamped on blur (0-50, 0-100), add-on editing (dollars -> cents), read-only mode, Estimate label.
- B-proposal-window: ProposalWindow.tsx/.module.css, format.ts, proposal-window.test.tsx. Read-only banner for non-draft, send / copy link / revise, PDF link as Button href.
- C-api-copy-tests: api.ts hooks, copy/proposals.ts (comingSoon removed), proposals.test.tsx (six tests), e1-routes.test.tsx (proposals row replaced by a real-view test).

## Reviews
- Review 1: verify failed, 3 findings. Contact check: F1 approve, F2 approve, F3 amend. Fixed/amended.
- Review 2: 1 finding (R2-1), amended.
- Review 3: 0 findings.

## Minors / unverified against T8
- PATCH body { options:[{id,...}], messageBody }, POST /revise -> ProposalView, GET /link -> {url}, POST /send -> {taskId}, GET /api/pricebook shape (c1 task-15 brief) are assumptions.
- Ledger carry: T8 PDF endpoint must send Content-Disposition: attachment.
- Run vitest from apps/web or with --project @roofline/web at root.

## Verify
vitest @roofline/web: 48 files, 467 tests passed; typecheck, lint, lint:css, build:web clean.
CI: run 38202469333 PASSED (ci-check).
