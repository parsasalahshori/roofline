# Whole-branch review findings: honest numbers (verified by reviewer)
## Fix now
- N-1 (important) agent-metrics.ts:80-83: a partly_done task with no done step (all failed) counts 0.5 in the success rate and in finishedToday. Count partly_done in partlyDone30d/finishedToday only when it has a done step (exists subquery); fully failed partly_done counts in ran30d only. db test.
- N-2 (important) = W-I4: money without the rate, link and "(estimate)" after the money on card and overview.
- N-3 = E-M4 recount lost update: lock tasks FOR UPDATE (sorted ids) in refreshTaskMinutes before summing.
- N-4 recount: concurrent recounts -> pg_try_advisory_xact_lock per company in every batch, or a running marker -> 409 "A recount is already running."; load overrides ONCE before the loop and pass to every batch; partial failure audit (S-M1).
- N-5 recount sets minutes_saved on unfinished tasks: update only tasks in a final status (done, partly_done, failed) or with minutes_saved not null.
- N-6 all-steps-switched-off approval counts as a done run: done counts in rate/finishedToday only with a done step (same exists); such tasks count as "not approved"? -> count in neither done nor ran (treat as declined-like) — track lead: exclude from ran30d and finishedToday; include in notApproved30d.
- N-7 agent-periods.ts startOfLocalDay at DST-at-midnight zones (America/Santiago 2026-09-06, America/Havana 2026-03-08): compute both offset candidates, return the earliest whose localDate === date. Tests with those two cases + US zones.
- N-8 = W-M1 hoursLabel small values ("under half an hour") + thousands separator.
- N-10 steps.ts create_ad_campaign units: typeof result.campaignId === 'string' ? 1 : countOf(result.campaigns). Test.
## Defer / tell other tracks
- N-9 Front Desk bookings folded into call/text rows: decide in Task 4 (Ruling AX-N to write when T4 starts: bookings snapshot shown as its own breakdown row).
- N-11 send_proposal / order_exact_report count 1 unit regardless of result: needs E1 to report {sent:1}/{ordered:1}; message E1 via the controller; A1 changes units at the next e1 merge.
