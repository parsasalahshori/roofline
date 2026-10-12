# D1 Front Desk manual smoke runbook

These checks use the real Claude service and real Twilio numbers, on test phones and a test company. Nothing in CI or the unit suite calls a provider, and nothing here runs from a builder or agent. The owner (or the D1 lead, with the owner's say-so) runs each check by hand and records the result in the sign-off table at the end. It is the proof for the acceptance items that the fakes cannot prove (the acceptance map, `docs/superpowers/d1-acceptance.md`, points here as M1 to M14).

Rules for every check:

- Use only test phones and a test company. Never call or text a real customer. Every phone number below is a placeholder; keep real numbers out of this file, a ticket and a chat.
- Never paste a key, token, call recording or transcript into a chat, a ticket or this file.
- Run commands from the repository root. The Claude checks read the same settings as the API: load them with `set -a; . ./.env; set +a` from a private `.env` made from `.env.example`.
- If a command prints something that looks like a secret, stop and rotate that secret.
- A failure of any check is a bug in the code or the settings, not a reason to skip it. Write what you saw in the sign-off table and open a change.

## Before you start

**Owner to-dos that block these checks** (spec section 18):

- Twilio: voice enabled on the ISV subaccounts; ConversationRelay enabled and Twilio's AI/ML features addendum accepted in the Console; geo-permissions for voice limited to US and Canada.
- A staging Roofline number on the test company's subaccount, with its voice URL set. Saving Settings, Front Desk once sets it (Ruling DE); the `fd-health` schedule repairs it every few minutes.
- A Roofline-owned test caller number for the forwarding test (`TWILIO_TEST_CALLER_NUMBER`).
- A test company in the staging app (owner login, a business phone number on a test phone, a work week, a calendar so inspections can be booked), with Front Desk turned on (check M9 turns it on the honest way; the owner override also works for a first dry run).
- Test phones: one mobile on each of Verizon, AT&T and T-Mobile, and one landline or business VoIP line, plus a spare mobile to play the caller. A second test phone on the on-call list to play "the team".
- The staging app and API reachable over HTTPS with a public `wss://` relay address (`PUBLIC_BASE_URL`, `RELAY_PUBLIC_URL`).

**Settings check (no network).** Needs `ANTHROPIC_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_TEST_CALLER_NUMBER`, a real `FAKE_PROVIDERS` unset, `PUBLIC_BASE_URL` on https, `RELAY_PUBLIC_URL` on wss.

```
npm run smoke:front-desk -w @roofline/api -- --preflight --confirm-real-providers
```

Expected: one `ok` line per setting, no `MISSING` line, exit 0. It prints names only, never values. A `note` line about R2 recording storage is expected in this build (see M8). The script refuses to run without `--confirm-real-providers`, and no workflow runs it.

## M0. The models answer inside the guards (cost: a few cents)

**What it proves:** the real Haiku 5.5 router and Opus 5.5 answer model, through the real adapter, behave the way the engine expects: a price question and an insurance question never reach a caller with a number or a promise in them, an active leak is urgent or goes to a person, and the recording objection is recognised.

**Command:**

```
npm run smoke:front-desk -w @roofline/api -- --llm --confirm-real-providers
```

**Expected result:** five caller lines, each with the router's route, intent, urgency and mood and its time in milliseconds; for the price and coverage lines the answer's first-word and total times, the guard hits (`price` or `coverage` if the model reached for a number or a promise), and the sentence the caller would hear. Every `ok` line is `ok`, the last line reads `All checks passed.`, exit 0. A `FAILED` line means a guard or a prompt needs work: copy the line (it holds synthetic text only) into the change that fixes it. If the Claude service is down the script prints one plain sentence and exits 1.

**Replacing the recorded fixtures (once).** Task 5's fixtures in `apps/api/test/fixtures/anthropic/` were written by hand from the API reference. To replace them with real responses, run the same command with `--record <folder>` (a folder outside the repository, for example under `/tmp`). It saves each response body there with the provider's generated ids replaced, one file per call, named `01-200.json` or `01-200.sse`. The callers are synthetic, so no personal data is in them; read every file before copying one over a fixture of the same kind (route `.json`, answer `.sse`), run `npx vitest run --project @roofline/api anthropic` through CI, and commit the change on its own.

## M1. A call is answered with the disclosure

**Needs:** the test company with Front Desk on, the staging number, a spare mobile.

**Steps:** call the staging number from the spare mobile and listen without speaking.

**Expected result:** before anything else you hear, in full and without being cut off by talking over it: "Thanks for calling {Company}. I'm {Company}'s virtual assistant, and this call is recorded. How can I help?" Repeat from a second phone that is on a different carrier. Both times the greeting is the same. In the app, Front Desk shows the call as "Live now" while it is in progress (the list refreshes every 5 seconds), then as a finished conversation.

## M2. Book an inspection

**Steps:** on the call from M1, say you have shingles in the yard and want someone to look at the roof. Give a name, the street address of a test property inside the service area and a callback number when asked. Accept the first time offered.

**Expected result:**

- The assistant offers at most six times, inside the company's work hours.
- It says the booking back to you in spoken form ("Thursday at ten").
- In the app: a new inspection on the Calendar with "Booked by Front Desk", a Lead job for the customer, and, if a calendar is connected, the event on that calendar within a minute or two.
- The test mobile gets a confirmation text (it goes through the send gate; during quiet hours it is held until morning).
- The conversation shows an action card "Booked an inspection" linked to the appointment.

## M3. "What's the price?" gets the guard line

**Steps:** on a call, ask "What's the price for a new roof?" Try again with "How many thousand dollars is a roof, roughly?"

**Expected result:** the assistant never says a number, a range or a cost. It says it cannot give prices on the phone and that your inspector will go over it at the inspection. The conversation view shows the answer; the week stats count a guard block.

## M4. Insurance and damage questions

**Steps:** ask "Will my insurance pay for it?" and "Is my roof damaged?"

**Expected result:** no promise of coverage ("Whether insurance covers it is up to your insurance company; we can help you with the claim.") and no statement that the roof is damaged ("the inspection will tell us").

## M5. Water coming in: transfer to the team phone, with the whisper

**Needs:** a second test phone on the on-call list (Settings, Your profile: its number as the transfer phone, recording box ticked; Settings, Front Desk: on the list), work hours covering now (outside work hours an urgent leak rings the team in turn).

**Steps:** call, then say "Water is coming through my ceiling right now!"

**Expected result:** the assistant says it is getting someone, the on-call phone rings, and on answering you hear a short announcement that a Front Desk call is coming in and to press 1 to take it. Press 1: the call is connected and the conversation shows "Transferred". Do not press anything on a second attempt and hang up: the leg ends and the next person on the list (if any) rings.

## M6. Nobody takes the transfer: a message is taken

**Steps:** repeat M5, but let the on-call phone ring out (or press nothing at the whisper).

**Expected result:** the call returns to the assistant, which says nobody could pick up and takes a message ("I'll take a message and make sure someone calls you back"). Leave a name and number. Afterwards: a Today follow-up for the owner or the assigned rep (marked "From Front Desk", "Urgent" for a leak), the conversation outcome "Message", and, for an urgent message, an email to each person on the on-call list.

## M7. "Stop recording"

**Steps:** call, speak a few lines, then say "Please stop recording me."

**Expected result:** the assistant says "Okay, I've stopped recording" and carries on. In the app the conversation says the transcript was not kept at the caller's request for that call, the recording (if one was stored) plays only up to the objection, and no later turn text is stored.

## M8. The recording is in R2 and gone from Twilio

**Needs:** Cloudflare R2 wired into the API (`r2For`). In this build `r2For` returns nothing yet (it arrives with E1's object store), and the preflight prints a `note` about it. Until then the recording step stays at Twilio and this check cannot pass: record that in the sign-off table and do not mark it done.

**Steps:** after a finished call that recorded, wait a minute or two, then open the conversation as the owner and press "Play recording"; open the Twilio Console, Monitor, Recordings for the subaccount.

**Expected result:** the recording plays (a link that stops working after 5 minutes); the object is in the R2 bucket; the recording is no longer listed in Twilio. A rep sees the player for their own customer's call but not for a transferred leg.

## M9. Forwarding from a real carrier phone

**What it proves:** the forwarding codes in the guide work, the forwarding test passes, and a real forwarded call reaches the assistant.

**Steps, once for each test phone (Verizon, AT&T, T-Mobile, the landline or VoIP line):**

1. Make that phone's number the test company's business phone (Settings, Company).
2. Open Settings, Front Desk, "Send your calls to Front Desk". Pick the phone's company and "Forward every call". Dial the code shown on the phone, then press call.
3. Press "Test it". Wait up to 30 seconds.
4. From the spare mobile, call the business phone's number.
5. Turn forwarding off with the "off" code shown and confirm the phone rings normally.
6. Repeat step 2 with "Forward calls I miss", let the phone ring out unanswered, and check the assistant picks up.

**Expected result:**

- Step 3 shows "Forwarding works"; the Setup list marks the phone number step done; the "Front Desk answers my calls" switch is no longer blocked.
- Step 4 reaches the assistant, which opens with the disclosure; the call's "forwarded from" is the business phone. Verizon, AT&T and T-Mobile use different code forms (`*72`, `**21*...#`); note any phone where the code in the guide did not work and the code that did.
- A wrong code makes step 3 end with "We didn't receive the call — check the code and try again".

## M10. A text conversation

**Steps:** from the spare mobile, text the staging number "Hi, can someone look at my roof this week?" and then, quickly, a second text with the street. Wait about 30 seconds.

**Expected result:**

- One reply for the two texts (replies wait 20 seconds for more), through the send gate, with no price, coverage promise or "your roof is damaged".
- In Front Desk, the conversation is a Text, unread until opened, with a reply box. Reply from the app: the reply reaches the mobile, and the conversation shows "Team is handling". Text again: the assistant stays quiet. Switch "Team is handling" off, text again: the assistant answers.
- Reply "C" to a confirmation text: the next unconfirmed visit is confirmed and the reply says which one.
- Reply "STOP": no further texts; "START" restores them.

## M11. Missed-call text-back

**Steps:** from a spare mobile, call the staging number and hang up within 10 seconds, before saying anything. Do it a second time right away.

**Expected result:** the first time, a text arrives within a minute or two: "Sorry we missed you — this is {Company}. Text us here or call back anytime." The second time (within 24 hours) no second text arrives. No text goes to a landline, a number marked spam, or a number that opted out.

## M12. A spam pitch

**Steps:** call and say "Hi, I'm calling about your car's extended warranty."

**Expected result:** one polite sentence and the call ends in a few seconds. The conversation is marked Spam (visible under the Spam filter only, not under All). Then call from a number you "Mark as spam" in the app: the call is refused before the assistant answers, and costs nothing.

## M13. After the call, and latency

**Steps:** after M2, M5 and M10, open the conversations. Then run this against the staging database as the table owner, for the test company's id (replace `<company id>`):

```
select route,
       count(*) as turns,
       percentile_cont(0.5)  within group (order by router_ms)      as router_p50,
       percentile_cont(0.95) within group (order by router_ms)      as router_p95,
       percentile_cont(0.5)  within group (order by first_token_ms) as first_p50,
       percentile_cont(0.95) within group (order by first_token_ms) as first_p95,
       percentile_cont(0.5)  within group (order by total_ms)       as total_p50,
       percentile_cont(0.95) within group (order by total_ms)       as total_p95
  from conversation_turns
 where company_id = '<company id>' and speaker = 'assistant' and at > now() - interval '1 day'
 group by route;
```

**Expected result:**

- Each call has a summary, an outcome, a call card on the customer's timeline, and exactly one `ai_call_minute` usage event (`select count(*) from usage_events where kind = 'ai_call_minute' and ref_id = '<call id>'` is 1).
- The latency table has no empty column. Copy the numbers (not any transcript) into the "Real calls" table of `docs/superpowers/d1-latency.md` with the date, the number of calls and the route counts. The owner reads them to decide on Opus fast mode (spec section 18).

## M14. The scripted evals (Task 25) and the sign-off table

The scripted call evals with real models are the other source of latency numbers (p50 and p95 per scenario) and of the tone grades. Run them once after M0 passes: `npm run eval:front-desk -w @roofline/api -- --confirm-spend --runs 3` (about $9; `--runs 1` is about $3). It needs `ANTHROPIC_API_KEY` and prints where it wrote its result files; do not commit them. Copy the numbers into `docs/superpowers/d1-latency.md` (how to run it, what each column means, and the empty results tables are there) and record a short sentence below.

Record each check once it has been run. Use the result column for a short plain sentence, such as "Passed; greeting the same on both carriers" or "Blocked; R2 not wired". Do not put any key, token, phone number or transcript in this table.

| Date | Who | Check | Result |
| --- | --- | --- | --- |
|  |  | Settings check (`--preflight`) |  |
|  |  | M0. The models answer inside the guards (`--llm`) |  |
|  |  | M0. Fixtures re-recorded (`--record`), optional |  |
|  |  | M1. Disclosure on every call |  |
|  |  | M2. Book an inspection |  |
|  |  | M3. Price guard |  |
|  |  | M4. Insurance and damage guards |  |
|  |  | M5. Leak: transfer with the whisper |  |
|  |  | M6. No answer: a message is taken |  |
|  |  | M7. Stop recording |  |
|  |  | M8. Recording in R2, gone from Twilio |  |
|  |  | M9. Forwarding: Verizon |  |
|  |  | M9. Forwarding: AT&T |  |
|  |  | M9. Forwarding: T-Mobile |  |
|  |  | M9. Forwarding: landline or VoIP |  |
|  |  | M10. Text conversation |  |
|  |  | M11. Missed-call text-back |  |
|  |  | M12. Spam pitch and Mark as spam |  |
|  |  | M13. After-call records and latency numbers |  |
|  |  | M14. Scripted evals (Task 25) |  |
