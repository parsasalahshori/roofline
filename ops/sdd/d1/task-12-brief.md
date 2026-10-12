### Task 12: Recording

**Base:** `d1-front-desk` after Task 10 is merged. From T4: `CallControl`. **[E1]** `ObjectStore` (R2) and `storeFile`/`readStoredFile` (E1 T5/T13); signed GET URLs may not exist — Ruling 6 of the plan (add `signedGetUrl` only if absent).

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

**Split:** Builder 1 `front-desk/recording.ts` (start when the relay session opens — after the non-interruptible greeting began — `recordingStatusCallback` → `/voice/recording`; objection handling: engine note + `stopRecording` + `calls.transcript_stored = false` from that turn on (turns stored with `text = ''` and a `system` turn "Recording and transcript stopped at the caller's request")); Builder 2 `hooks/twilio-voice-recording.ts` + the `fd-recording-store` job (fetch from Twilio, put to R2 `recordings/<companyId>/<callId>.mp3` via `ObjectStore`, `stored_files` row kind `call_recording`, then `deleteRecording` at Twilio; retries; R2 not configured → keep at Twilio up to 7 days and warn); Builder 3 signed playback (`GET /api/calls/:id/recording` → 302 to a 5-minute signed R2 URL; roles per spec §11) + tests.

**Files:** Fill the listed files; Modify `apps/api/src/providers/object-store.ts` only to add `signedGetUrl(key, seconds)` if E1 lacks it (Ruling 6); Test `apps/api/test/front-desk/recording.test.ts`.

**Tests:**
- recording starts once; objection stops recording and transcript storage; store job copies then deletes at the fake Twilio, idempotent; playback roles (rep only for own customers, not transferred legs; office/owner yes); company B 404.

**Carries and rulings:**
- Recording starts after the non-interruptible greeting begins; `recording_retention_days = 0` means never record.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): call recordings — stop on objection, copy to R2, delete at Twilio, signed playback`
