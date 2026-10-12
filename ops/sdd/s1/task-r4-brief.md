### Task R4 (whole-branch review): web fixes

**Base:** `s1-storm` (after T28 merges). Web only (`apps/web/**`).

**Fixes (confirmed by the S1 review):**
1. **(critical) The map storm layer always gets a 400.**
   - `features/storm/layerApi.ts` sends a fractional zoom (`Math.round(zoom*10)/10`, from `MapView.tsx:113` / MapLibre), and the API takes whole numbers only (`routes/storms.ts` `WHOLE = /^\d+$/`).
   - Fix: send `Math.round(zoom)` clamped to 0..22, in both the query key and the URL.
   - Add a MapView/layer test with a fractional zoom (e.g. 3.5), asserting the request uses `zoom=4`.
2. **(important) Reps have no way into "My routes".** Nothing links to `/storm/routes`.
   - Fix: add a "My routes" link in StormWindow (all roles) and in the phone MoreSheet (or wherever F2's phone shell lists apps); copy in `copy/doors.ts`.
   - Test the click-through.
3. **(important) Ad accounts never say why they are pending or in error.**
   - The API row has `lastErrorPlain` (our own plain sentence, safe to show) and `currency`, but no `reason`.
   - Fix: change `AdAccount` in `api/types.ts` to the real row. `AdConnections` shows `lastErrorPlain` when the status is pending or error. Drop the dead `reason` copy.
   - `useCheckAdAccount`/`useRemoveAdAccount` return `{ account }`.
   - Update the `settings-ads.test` fixtures to the real row shape.
4. **(minor) Plan status.** `copy/storm.ts` `planStatus` covers every `TASK_STATUSES` value (approved, declined, expired, partly_done, needs_attention as well), typed `Record<TaskStatus, string>`.
5. **(minor)** StormWindow shows a `Skeleton` with a `role="status"` label while the list loads.
6. **(minor)** The StormDetail stat cards use count-free labels ('Customers hit', 'Homes hit') beside the number.
7. **(minor)** The spend Edit field uses `inputMode="decimal"` for `maxSpend` (`StepFieldsSheet.tsx:186`).
8. **(minor)** RouteMap: the rep's dot gets its own effect (`setLngLat`), so a GPS update doesn't rebuild every stop marker.
9. **(minor)** `RouteMap.module.css:26,50`: the raw `rgb(0 0 0 / 0.35)` shadows become a token (add `--shadow-marker` in the shared tokens if none fits).
10. **(minor)** StormDetail shows "Draft a new plan" when there is no plan, or the plan is `draft`, `expired` or `declined`. Task R2a makes the API allow exactly those. When the API answers 409 with 'Storm Scout is paused. Turn it back on in Agents to draft a plan.', show that message.
11. Remove the dead `doors.routesComingSoon` and `routeComingSoon` copy.

**Verify:** typecheck, lint, lint:css, web vitest (slot-wrapped); ci-check with `CI_JOBS="Platform E2E Hail"`.
**Commit:** `fix(web): storm layer zoom, My routes link, ad account reasons, full plan statuses`
