# D1 Task 4 report: API skeleton

## Built
- P1-config-deps-helpers: config (new keys; RELAY_TOKEN_SECRET derived via HKDF from ENCRYPTION_KEY when unset; wss-only RELAY_PUBLIC_URL in production), deps (UnconfiguredLlm/CallControl, createLlm/createCallControl/createLineLookup; no real Anthropic client), test helpers, fd-retention/fd-health stubs, config/jobs/pgboss test updates, .env.example, README.
- P2-seams-fakes: ScriptedLlm, FakeVoiceSession, fake call control, fake line lookup, front-desk-fakes.test.ts.
- P3-jobs-hooks-mounts-relay: JOB_NAMES/SCHEDULES/handlers/worker wiring, twilio voice and status hooks, conversations/front-desk/calls/blocked-numbers/transfer-phone routes, /relay upgrade (1008 stub, other paths refused), app/server/index wiring, front-desk-skeleton.test.ts.

## Reviews
- Review 1: verify failed, 3 findings. Contact check: F1 approve, F2 amend, F3 amend. Fixed.
- Review 2: verify passed, 0 findings.

## Minors
- Prettier not enforced repo-wide (29 files already warn); not reformatted.
- DB-backed api tests are unrun locally (no Docker); CI covers them.

## Verify tail
typecheck OK, lint OK, vitest @roofline/shared: 20 files, 801 tests passed.
