# F1 follow-ups (from the task reviews and the final whole-branch review)

- **Built:** F1 platform core, on branch `f1-platform-core`, fd9603e..66638a8.
- **Full decision record:** `docs/superpowers/f1-decision-log.md` (every controller ruling, plus every deferred finding).

## Done in F3

Each item below was a blocker before texting could go live; the F3 task that did it is in brackets.

- **Inbound STOP can be lost on a crash:** the inbound insert is now the claim, inside the tenant transaction (a unique `(company_id, provider_message_sid)` with `ON CONFLICT DO NOTHING`). (Task 10)
- **Lease heartbeat for big batches:** a long batch keeps its step lease. (Task 12)
- **Reconcile with Twilio's own opt-out handling:** Twilio's `OptOutType` STOP, START and HELP count, and carrier opt-outs are recorded without answering twice. (Tasks 10 and 13; keep Advanced Opt-Out on, see the README to-dos)
- **Supabase Data API exposure:** the Data API grants are revoked on migrate and `db:preflight` checks them. (Task 2)
- **Extensions schema:** `postgis` and `citext` are moved into `public` on migrate and checked by preflight. (Task 2)
- **Delivery reports that arrive early:** an early report is saved and applied when the send is saved; a daily sweep prunes stale ones. (Task 11, prune: P3a)
- **Inactive or unusual numbers:** STOPs and delivery reports for inactive numbers are handled, and short-code senders are stored without a 400. (Tasks 10 and 11)
- **HELP reply:** it falls back from the company phone to email, website, then the number they texted. (Task 10)
- **Smaller F3 items:**
  - toll-free and non-US NANP (Canada, Caribbean) numbers are refused as not textable. (Task 8)
  - the brand check replaces `instanceof SmsRefusedError`, via `isSmsRefusedError`. (Tasks 8 and 13)
  - a GIN index on `customers.phones` (and one on emails) is in the F3 schema. (Task 1)

## F2 (screens) needs these

- **Gave-up steps.** A batch step that hit "needs attention" still sends its scheduled texts, but its result never updates. Either have the settler also refresh those steps, or park instead of giving up.
- **Retry button.** Key it on the step's status, not on whether `errorPlain` is set (a requeued step shows the "we'll try again" text).
- **Rerun.** It turns switched-off steps back on (product question), and `TaskView` lacks `rerunOfTaskId`.
- **Approvals.** The list has no pagination. The `step.edit` audit stores the full payload even for a toggle.
- **Rep visibility.** Job audit rows hold `valueCents`; any audit viewer must hide it from reps.
- **Unknown senders.** Their possible-opt-out flags aren't listable until an inbox exists.
- **Linting.** The lint covers `*.ts` only; extend it to `.tsx` for the web app.
- **Body size.** A 5,000-id batch is about 200 KB, close to the 256 KB JSON body limit. Raise the limit for the approvals editor, or store recipients separately.

## Owner product decisions (no code needed until you decide)

- **Open leads.** Reps can change the stage of, archive, or reveal the value of open (unassigned) leads by assigning them to themselves.
- **Archived leads.** Archived unassigned leads keep their customer and address visible to every rep.
- **Google linking.** It only one-click-links accounts on Gmail or Google Workspace emails. Microsoft 365 roofers keep their passwords.
- **Address time zones.** `PATCH timezone: null` can't put an address back to following the company's time zone.

## Deploy notes

- **Boot order** is in the README ("Running in production"): `npm ci --omit=dev`, then migrate with the owner URL, then `set-role-passwords`, then the API, then the worker.
- **The migration owner** needs `CREATEROLE` and `CREATE` on the database. No superuser is needed (verified on PG16 and on a Supabase PG17 image).
- **Behind a proxy:** set `TRUST_PROXY`, or every IP rate limit shares one bucket. Run `ConsoleMailer` without bodies in production.
- **Fresh databases:** run `set-role-passwords`.
