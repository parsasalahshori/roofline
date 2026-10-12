# Task 22 report: conversation view and inbox reply

Built (web only): A-view (ConversationView, transcript and tool action cards), B-summary-recording (RecordingPlayer, SummaryPanel), C-reply-window (ReplyBox, ConversationWindow, mark-read once per id), plus conversation-api.ts hooks and copy/front-desk-conversation.ts.

Review 1: verify failed, 1 finding; contact check amended it (F1 = amend). Review 2: verify passed, 0 findings.

Minors: outcome Pill not rendered (no outcome labels in copy; PillTone has no danger); spam Pill renders as a button in the kit; transcriptNotKept shown if any call has transcriptStored false.

Verify: typecheck, lint, lint:css clean; web vitest 50 files, 482 tests passed.
