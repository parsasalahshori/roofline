### Task 22: Web: conversation view and inbox reply

**Base:** `d1-front-desk` after Task 20 is merged. Real (F2): kit components; native `<audio controls>` is allowed (not a button).

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

**Split:** Builder 1 `ConversationView.tsx` (header, transcript with speaker styles, truncated marks, "Transcript not kept at the caller's request", tool action cards linking to records); Builder 2 `RecordingPlayer.tsx` (fetches the signed URL on play; native `<audio controls>`) + summary panel + "Mark as spam" / "Call back"; Builder 3 `ReplyBox.tsx` (texts; gate errors shown plainly) + handling switch + tests.

**Carries and rulings:**
- Recording URLs are fetched on play (5-minute signed URLs).

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): conversation view with transcript, recording, summary and replies`
