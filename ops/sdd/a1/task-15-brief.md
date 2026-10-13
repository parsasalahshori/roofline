### Task 15 (track lead): web polish for the Agents screen

**Base:** `a1-agents` after Task 12 and the `s1-storm` merge. Not in the plan: it collects the group-check findings of Tasks 9-12 (ledger, "Carried polish" and "T12 merged" entries) so the whole-branch review starts clean.

Read first: `ops/sdd/a1/global-constraints.md`; `ops/sdd/a1/progress.md` (wave-3 web and T12 entries).

**Do:**
1. **Hourly rate is editable** (spec §3.3, "with a link to change the rate"): Settings → Company gets an "Hourly rate for time saved" money field (dollars, whole or cents; 0-1000 $/hour; plain-English error) that sends `hourlyRateCents` through the existing company PATCH (`apps/api/src/routes/company.ts` already accepts it; check its validation and match it). Owner edits; others see it read-only or not at all, matching the rest of CompanyTab. The Agents → "How we count" rate line links here, shown only when `canEdit`.
2. **TimeBaselines**: the recount button is disabled (with a one-line hint) while there are unsaved edits; the save mutation writes the PUT response into the query cache (`setQueryData`) before invalidating, so the inputs do not flicker; rename the local `moneyLabel` (it shadows the shared one) to `rateLabel`; use the real S1 token names in `TimeBaselines.module.css` and `RecountSection.module.css` (no fallback-only tokens).
3. **AgentCard**: the status chip uses `@roofline/ui` `Pill`; remove the doubled `styles.card`; the link's accessible name keeps the figures (drop `aria-label={name}`, or use `aria-labelledby` pointing at the heading plus the figures).
4. **Agent page**: `PauseSwitch` resets its mutation when the sheet closes (no stale error after cancel); `RunNowButton` clears a stale error once a later `nextAllowedAt` arrives; `useAgentDetail` keeps the previous period's data while the next loads (`placeholderData: keepPreviousData`); hide Run now from people who cannot run it (the POST needs `approve_internal`: check the permission helper the web already uses); section headings consistent (window title h2, sections h3).
5. **Copy**: remove the remaining unused keys in `copy/agents.ts` (grep each before deleting); one shared `estimate` string ('(estimate)') and one `comingSoon` used by every Agents component; move the mid-file `import type` in `copy/agents.ts` to the top.
6. **Query keys**: add `agentsKeys.overview` and `agentsKeys.detail(agent, period)` and use them (invalidations still use `agentsKeys.all`).

**Do not:** touch the API beyond what the company PATCH already accepts; change `packages/shared/src/agents-api.ts`; edit `shell/topbar/AgentsWorking.tsx`.

**Tests:** the hourly-rate field (owner saves cents; validation; office/rep view), recount disabled while unsaved, AgentCard accessible name includes the time figure and "(estimate)", PauseSwitch cancel clears the error, Run now hidden for a rep. Existing web tests stay green.

**Verify:** web vitest, typecheck, lint, lint:css, build:web; `ci-check` with `CI_JOBS="Platform E2E"`.

Commit: `feat(web): editable hourly rate and Agents screen polish`
