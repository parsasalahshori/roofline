# D1 follow-ups queued behind RC-2 (D1 lead)
- E1 CV review #1: on a reused conversation, engine.start must seed nextPosition and turn count from the stored turns (RC-1's insertTurn allocation also covers the collision).
- E1 CV review #6: take_message for an unknown caller must be visible. Show input.reason on the action card even after a recording objection (the caller deliberately left it).
- E1 CV review #2 (Ruling BJ assigns it to me): the AI cap counts `ringing` calls that never go to the AI (ring_first, Front Desk off, read-only, over-cap voicemail). Inside the locked transaction, set non-relay paths to `ringing_team`, and count only `ai` plus relay-reserved calls.
- C1 RA review #8 (engine.ts, after RC-1): the {name, ok} choice for tool rows is made when the call is pushed, not when it is saved, so a turn in flight at the moment of an objection keeps the pre-objection tool args. Decide at save time.
- C1 RA review #6 (later): playback reads the whole object for every Range or seek request; it needs a ranged get in the object-store seam.
- C1 RA review #7: no change needed. relayCallById reads only SELECT (id, company_id, call_sid, status) on calls, which Ruling BJ keeps for app_system.
