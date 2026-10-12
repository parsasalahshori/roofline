
# Task 4 report (e1-t4, commit a96d7be)

Built: P1 proposals.ts (canonicalJson, signedDocument, SignatureRecord) + proposals.test.ts; P2 steps.ts send_proposal (message, 20 min) and order_exact_report (spend, 10 min) + registry test; P3 steps-e1.test.ts. No cross-package edits needed (apps/api handlers use Partial<Record<StepType,...>>).
Review round 1: 1 finding; contact check F1 = amend (amended). Review round 2: 0 findings.
Minors: none recorded.
Verify: shared vitest 17 files / 408 tests pass; web copy-rules 5 pass; npm run typecheck (tsc -b) exit 0; npm run lint exit 0.
CI: run 38195634306 FAILED for an infrastructure reason, not code: all three jobs ended in 2s with no runner/steps; annotation "The job was not started because recent account payments have failed or your spending limit needs to be increased." Not retried (a retry cannot pass until GitHub billing is fixed).
