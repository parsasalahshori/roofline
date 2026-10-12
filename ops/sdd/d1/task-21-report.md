# Task 21 report: Web Front Desk window and stats

Built:
- A-hooks: features/front-desk/inbox-api.ts (useConversations infinite query, useWeekStats, inboxPollInterval 5 s live / 30 s idle, flattenItems); api.ts appends re-exports only. Test d1-t21-inbox-api.test.tsx.
- B-window: FrontDeskWindow, ConversationRow (+ CSS modules): filter chips over CONVERSATION_FILTERS, unread, outcome tags, live rows with pulsing dot (off under prefers-reduced-motion), empty state, Show more. d1-t21-window.test.tsx; d1-routes.test.tsx stubs GET /api/company.
- C-stats: WeekStats with six StatCard tiles ('212 of 500 minutes', or used only when aiMinutesIncluded is null). d1-t21-week-stats.test.tsx.
- Copy: copy/front-desk-inbox.ts.

Deviations (accepted): chips are Button with aria-pressed (Pill cannot); outcome/urgent/team tags are styled spans (Pill renders a button, would nest in the link); timezone passed to rows from one useCompany call.

Review round 1: verify passed, 0 findings.
Minors: none.

Verify tail: typecheck, lint, lint:css clean; @roofline/web 50 files, 478 tests passed.
