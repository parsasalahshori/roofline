# F1 follow-ups (from the task reviews and the final whole-branch review)

- **Built:** F1 platform core, on branch `f1-platform-core`, fd9603e..66638a8.
- **Full decision record:** `docs/superpowers/f1-decision-log.md` (every controller ruling, plus every deferred finding).

## Must be done before texting goes live (F3 blockers)

- **Inbound STOP can be lost on a crash.** The webhook's dedupe claim commits separately from the work. Make the claim part of the tenant transaction, for example with a unique `(company_id, provider_message_sid)` on inbound rows plus `ON CONFLICT DO NOTHING`.
- **Lease heartbeat for big batches.** A 5,000-recipient batch can outlive the 10-minute step lease at real provider latency. Add a lease heartbeat, or split batches into chunks.
- **Reconcile with Twilio's own opt-out handling.** Messaging Services can intercept STOP/START before our webhook sees them.
- **Supabase Data API exposure.** Supabase's default grants expose new `public` tables (including `users.password_hash` and `sessions`) to `anon`/`authenticated`. Revoke those grants or disable the Data API before the first deploy.
- **Extensions schema.** Install `postgis` and `citext` into `public`. If they go into Supabase's `extensions` schema, app-role email lookups silently become case-sensitive.
- **Delivery reports that arrive early.** A `delivered` callback that arrives before the message SID is saved is dropped.
- **Inactive or unusual numbers.** STOPs and delivery reports for inactive numbers are dropped, and short-code senders get a 400.
- **HELP reply.** It needs contact details even when the company has no phone number.
- **Smaller F3 items:**
  - toll-free and Caribbean numbers are accepted, so a textability check is needed
  - add a brand check alongside `instanceof SmsRefusedError` if the Twilio adapter is bundled separately
  - add a GIN index on `customers.phones` before CSV import brings 20k-row companies

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
