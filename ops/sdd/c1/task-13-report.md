
# Task 13 report: C1 calendar push job (branch c1-t13, commit 1cc5cd7)

Built: A-event-text (apps/api/src/calendar/event-text.ts + pure test), B-push-and-links (apps/api/src/calendar/push.ts, packages/db/src/repos/calendar-links.ts), C-tests (apps/api/test/calendar-push.test.ts, 8 tests).

Review 1: 3 findings. F1 amended, F2 amended, F3 rejected (contact check). Review 2: 0 findings.

Minors / open issue: a never-linked appointment whose first push fails has no calendar_event_links row (connection_id and provider_event_id NOT NULL), so setPushError (update-only) records nothing and view sync 'failed' cannot show for a first-push failure. The sync derivation needs another source (controller decision).

Verify: typecheck and lint clean (no output). CI run 38202447014: Platform (lint, typecheck, DB tests) PASSED, v1 node:test PASSED, E2E (Playwright) FAILED: 1 failed / 29 passed, [desktop] e2e/setup.spec.ts:33 "later steps say Coming". This is a web setup-page spec; this task changes no web files, so it is most likely a T12 (calendar connect/setup item) interaction already on the base. Not fixed here (outside file ownership).
