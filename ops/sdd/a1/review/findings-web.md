# Whole-branch review findings: web (verified by reviewer)

## Fix now
- W-I1 AgentPage.tsx:23: coming-soon agents (claims, scheduler, follow_up) get a full working page (pause switch → 409). Show the coming-soon EmptyState when the agent is not a launch agent and G1_AGENTS_SHIPPED is false (or detail.card.status === 'coming_soon'); fix a1-routes.test.tsx:97; test /agents/claims shows agentComingSoon and no switch.
- W-I2 RecentTasks.tsx:30: same as S-M6 (server href; plain row when null).
- W-I3 ActivityFeed.tsx:41, AgentsWindow.tsx:19, AgentPage.tsx:49: a failed refetch / Show more replaces loaded content with the error. Show the error state only when data === undefined; otherwise keep content and show a small Banner; feed uses isFetchNextPageError next to Show more; add a retry Button in each error state.
- W-I4 money line lacks the rate and the change-rate link (spec 3.3: "≈ $870 of staff time at $28/hour" + link). Render "≈ $870 of staff time at $28/hour (estimate)" with a link to /settings/company for the owner, in AgentsWindow totals, AgentCard (rate may be omitted on cards if too long — keep at least on the totals line and agent page), AgentPage. Respect S-M4: when hourlyRateCents is null (reps), hide money entirely.
- W-M1 "about 0 hours" next to "≈ $5": below 15 minutes say "less than half an hour" (shared hoursLabel change in packages/shared/src/metrics.ts + tests) — keep "about"/"(estimate)" rule satisfied (e.g. "less than half an hour (estimate)" counts: copy test must accept it; update the test rule to allow "less than" as the approximate marker).
- W-M2 clock times in the browser zone: agentTimeLabel(iso, zone) with the company timezone (useCompany().data?.timezone, as Today/Calendar do), reused by RunNowButton.
- W-M3 TimeBaselines unsaved lock ("1.50" vs 1.5): unsaved compares numerically for valid drafts.
- W-M4 loading states: wrap Skeletons in role=status with an aria-label (TimeBaselines, AgentsWindow, ActivityFeed); WaitingList shows a loading status instead of null.
- W-M5 AgentCard link name includes the status chip (and finished today optional).
- W-M6 RecentTasks drop the aria-label overriding the content.
- W-M7 task kind labels from copy (TASK_KIND_LABEL in copy/status.ts with a generic fallback).
- W-M8 WaitingList container: <section aria-label> (or role=region); update locators if needed.
- W-M9 Run now offered while paused: hide the button and show a paused note when detail.paused (API also refuses: E-M7).
- W-M10 rep links: hide "How we count" and render rule values as plain text for reps (API sends links: [] for reps per S-M5).
- W-M11 baseline input labels visually hidden (Field labelHidden or a visually-hidden class); on phones add inline labels for unit/basis.
- W-M12 hourly-rate hint as Field help (aria-describedby).
- W-M13 MiniChart table dates "Oct 12"; TimeBreakdown units toLocaleString.
- W-M14 one cents formatter shared (rateLabel/toDollars), one clock formatter; stale copy header.
- W-M15 aria-busy + dim while placeholder data shows.
- W-T1 agent-page.test.tsx:83/:273 assertions that prove nothing: distinctive week figures, assert absent before release and present after.
- W-T2 e2e waiting-list: after opening the draft, assert the review shows the draft title (investigate why the dialog assertion failed: the approvals review renders in the AppWindow dialog named for approvals — use getByRole('dialog', { name: <approvals window title> }) or the draft title text).
- W-T3 stale comment agents-window-copy.test.tsx:28.
- W-T4 tests for I1, I2, I3, hourly-rate save invalidates ['agents'].
