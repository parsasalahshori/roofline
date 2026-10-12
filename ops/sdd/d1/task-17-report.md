# D1 Task 17 report: number voice setup and forwarding test

## Built
- P1 setup-item (shared, db, tests): phone_number removed from COMING_WITH_BY_KEY; SetupFacts.forwardingVerified from company_settings.forwarding_verified_at; resolveItem phone_number case; shared, api and web tests updated.
- P2 forwarding-test (api, db): front-desk/forwarding-test.ts router (POST/GET /api/front-desk/forwarding-test), repos/forwarding-test.ts, fd-forwarding-test job, test-call branch in hooks/twilio-voice.ts. No migration: the test is a calls row (status ringing, conversation_id null). Owner or office only, one test per company per minute (advisory lock), 503 when placeTestCall throws.
- P3 number-voice: voice-routing.ts helpers (numbersNeedingVoiceUrl, markVoiceUrlSet, marker voice_url), front-desk/number-voice.ts applyVoiceUrls, fd-health repair pass, ensureVoiceUrl exported from jobs/scheduler/fd-health.ts (boundaries test bans system imports under front-desk/).

## Review rounds
- Review 1: verify passed, 0 findings.

## Minors
- Pending window is 60 s while the timeout job runs at 30 s; a late arrival after the job fails it is not verified.
- A number whose setVoiceUrl keeps failing is retried every 2 minutes with no backoff.
- Task 18 should call ensureVoiceUrl from the fd-health module (or enqueue a job).

## Verify
typecheck and lint clean; shared 803 tests passed; web 396 tests passed. DB-backed suites run on CI only.
