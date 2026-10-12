# Task 90 report: security hardening (relay socket, voice hooks)

## Built
- A-relay (relay-server.ts, relay.test.ts): maxPayload 64 KiB (close 1009), pre-auth queue cap 32 (close 1008), pre-auth socket cap 50 (503), calls ended/failed/rejected denied at auth and removed from the registry; ringing_team and transferred message-only reconnects still accepted.
- B-voice-hooks (twilio-voice*.ts, voice-hooks.test.ts, recording.test.ts, plus recording-store.test.ts and spam.test.ts SID fixes): CallSid shape check (400) on every voice route, replay guard on /voice (non-ringing call gets Hangup), forwarding-test arrival passes forwardedFrom and stirVerstat. Behaviour change: a replayed /voice for a rejected call now gets Hangup.
- C-forwarding (forwarding-test.ts, forwarding.test.ts): arrival verifies only if ForwardedFrom equals the business phone or StirVerstat starts with TN-Validation-Passed; toll-free and non-US business phones get 422 before placeTestCall.

## Review rounds
- Round 1: 1 finding, contact check approve, fixed.
- Round 2: 2 findings (R2-1, R2-2), contact check approve, fixed.
- Round 3: 0 findings.

## Minors
- Relay flood test relies on one-tick read; if CI flakes, hold relayCallById with a deferred promise.
- If handleUpgrade never calls back the unauth counter is not decremented (accepted).
- Owner to-do: Twilio voice geo-permissions on the master account.

## Verify tail
typecheck clean, lint clean, @roofline/shared: 21 files, 810 tests passed. DB-backed api tests run on CI only.
