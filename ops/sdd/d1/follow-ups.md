# D1 follow-ups queued behind RC-2 (D1 lead)
- E1 CV review #1: on a reused conversation, engine.start must seed nextPosition and turn count from the stored turns (RC-1's insertTurn allocation also covers the collision).
- E1 CV review #6: take_message for an unknown caller must be visible. Show input.reason on the action card even after a recording objection (the caller deliberately left it).
- E1 CV review #2 (Ruling BJ assigns it to me): the AI cap counts `ringing` calls that never go to the AI (ring_first, Front Desk off, read-only, over-cap voicemail). Inside the locked transaction, set non-relay paths to `ringing_team`, and count only `ai` plus relay-reserved calls.
