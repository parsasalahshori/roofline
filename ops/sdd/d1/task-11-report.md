# D1 Task 11 report: Relay WebSocket server

## Built
- A-token-and-db: relay-token.ts (sign/verify, timing-safe), packages/db system/relay-tokens.ts (relayCallById), twilio-voice-common.ts relay url with ?t= token, tests.
- B-session-loop: relay-session-loop.ts runRelayLoop (ordered turns, drains the turn generator to the end, interrupt, sentence streaming), relay-loop.test.ts.
- C-server-accounting: relay-server.ts attachRelayUpgrade (setup auth within 5 s, 1008 on bad/expired/mismatched token, one socket per call via RelaySessions, idle prompt then end, ai_seconds accounting), calls.ts aiStartedAt/addAiSeconds, relay.test.ts.
- Lead: eslint.config.js DB_SYSTEM_ALLOWED gains apps/api/src/front-desk/relay-server.ts (builder 3 blocker).

## Reviews
- Review 1: verify failed, 2 findings. Contact check: F1 approve, F2 amend. Fixed.
- Review 2: verify passed, 0 findings.

## Minors
- Interrupt test in relay.test.ts asserts only no text frames after an interrupt; truncation row is covered in relay-loop.test.ts.
- Optional TwiML ?t= test skipped.

## Verify tail
typecheck ok, lint ok, vitest @roofline/shared 802 passed (20 files).

## CI round 1 (run 38224032023)
Platform failed: relay-loop.test.ts used a made-up call id, so the engine's turn-row insert (FK to calls) failed silently. Fix: the rig inserts a real call and uses its id.
