# Front Desk review: live tasks, time saved and numbers (verified by reviewer, a1-agents 106d80b)

## Fix (A1)
- FD-1 (important) agent-metrics.ts:273 frontDeskConversationCounts counts every channel; today only text spam qualifies (D1 never links calls.conversation_id) → card shows 100% from spam texts. Fix: conversations.channel = 'voice' and exclude outcome 'spam' from the denominator. (D1-side root cause reported to D1.)
- FD-2 (important) feed for live tasks: createLiveTask writes created/step_done/finished → three wrong rows per call ("drafted a plan", "a step finished", "Finished"). Fix: FeedRow gains taskMode; live created renders "{Agent}: {title}{ for firstName}"; hide step_done and the creation-time finished for mode 'live' (query filter or render rule); keep close-time finished and step_attention. Tests.
- FD-3 (minor) service.ts addToLiveTask revalues past replies at the current baseline. Fix: incremental snapshot (previous minutes_saved + minutesFor(text_reply, added) + booking minutes; units add; minutes_per_unit = minutes/units). Test.
- FD-4 (minor) time-baselines.ts listRecountSteps reads without lock; recount can overwrite a fresher snapshot. Fix: FOR UPDATE (step then task lock order). Test if practical.
- FD-5 (minor) texts.ts:226-237 counts a reply whatever sendQueuedText returned. Fix: count only on 'sent'; scheduled replies: record gap in report (counted later only if the dispatcher path is wired — out of scope).
- FD-6 (minor) since T22 a needs_attention live Front Desk task waits on "you"/"office" instead of the job's assignee. Fix: for front_desk live attention tasks with a job subject, waitingOn from jobs.assigned_user_id like follow-ups.
- FD-7 (minor) success-rate rep scope uses jobScope-only customers; use customerScope(ctx).
- FD-8 (minor) rejected spam calls make tasks even when Front Desk is paused/disabled (0 minutes but count in finishedToday/charts). Fix: skip the spam task when call.status === 'rejected' and aiStartedAt is null (screening rejected it before Front Desk ran).

## D1 side (report to D1 via the controller)
- calls.conversation_id is never set (engine.start → insertConversation without the call link): voice conversations never end/get outcomes, call bookings always 0, every call titled "Answered a call", no call task ever gets a subject or needs_attention, the model-failure marker is never written. Fix in D1: pass callId through engine.start and link the call in the same transaction; when no conversation is found take the transfer outcome from the call row.
- Text bookings 0 until D1's text booking tools exist (TEXT_TOOL_HANDLERS = {}).
