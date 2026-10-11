### Task 19: F2 final-review fixes

Source: the final F2 whole-branch review (workflow wf_d7a3ff8b-491). Every item below was confirmed by an Opus verifier against the code. Base: f2-shell 11abfea (all F2 tasks merged).

**Split (file-disjoint):**
- Builder 1 (map): `apps/web/src/shell/Shell.tsx`, new `apps/web/src/shell/map/MapErrorBoundary.tsx`, `apps/web/src/app/router.tsx` (errorElement), copy for the route error in `apps/web/src/copy/errors.ts` (or the existing errors copy file), a new test `apps/web/test/map-resilience.test.tsx`. Items I1 and I2.
- Builder 2 (switch + team): `apps/web/src/api/hooks.ts` (useSwitchCompany), `apps/web/src/shell/topbar/UserMenu.tsx`, `apps/web/src/features/settings/api.ts` (useUpdateMember), tests in `apps/web/test/company-switch.test.tsx` and the TeamTab test file. Items M2 and M4.
- Builder 3 (copy + e2e): `apps/web/src/copy/review.ts`, `apps/web/test/review-copy.test.ts`, `apps/web/e2e/shell.spec.ts`. Items M1 and M3.

**Important**

I1. Company switch leaves the old company's pins and open PinCard on the map (violates Ruling O). Fix: in Shell.tsx read the active company id from `useMe().data?.company.id` and render the map with `key={companyId ?? 'none'}` so MapView remounts on a switch (clears shownPins, picked, bbox, refs, failed state; refits B's area). Test: render the shell with company A pins and an open PinCard, run the switch with B's pins request pending, assert no A features reach the layer data and no PinCard is rendered.

I2. No error boundary: a failed lazy MapView chunk (stale tab after deploy, flaky network) blanks the whole app with React Router's default error page; spec 4.3 requires the app to stay usable with the banner "The map is having trouble loading. Your work is safe." Fix: (1) `MapErrorBoundary` class component in apps/web/src/shell/map/ whose fallback is `<div role="status"><p>{mapCopy.error}</p></div>` with MapView's banner styling; in Shell.tsx `<MapErrorBoundary><Suspense fallback={null}><MapView key=... onOpen={open} /></Suspense></MapErrorBoundary>` (the key from I1 goes on MapView; put it on the boundary too so a switch also resets a failed boundary). (2) An `errorElement` on the Shell route (or root) in router.tsx with plain copy from a copy file and a Reload button (ui Button). (3) Test: mock the MapView dynamic import to reject; render the shell route; assert the top bar, the dock and the banner text are present.

**Minor (verified)**

M1 (pluralise review copy).
In apps/web/src/copy/review.ts:
1. Change `recipients` to `(count) => `${count} ${count === 1 ? 'customer' : 'customers'}``.
2. Turn RESULT_WORDS into `Record<string, readonly [singular: string, plural: string]>`. Keys that never change get the same word twice: sent ['sent','sent'], delivered ['delivered','delivered'], failed ["couldn't send","couldn't send"], blocked ['held back','held back']. Give replies ['reply','replies'] and booked ['inspection booked','inspections booked'].
3. In `resultLines`, push `${value} ${RESULT_WORDS[key][value === 1 ? 0 : 1]}`.
4. In apps/web/test/review-copy.test.ts, add cases for count 1: recipients(1) should be '1 customer', and resultLines({ replies: 1, booked: 1 }) should be ['1 reply', '1 inspection booked']. Keep the existing plural and zero cases.

M2 (self-demotion leaves stale owner UI).
In `useUpdateMember`'s `onSuccess`, keep returning the `keys.team` invalidation. Also start `void queryClient.invalidateQueries({ queryKey: keys.me })` and `void queryClient.invalidateQueries({ queryKey: keys.approvals })`. They are cheap and only matter when the edited membership is the viewer's own, so they can always run. You can await all three with `Promise.all` if the Team tab should re-render with the new role before the select is released. Add a TeamTab test: as an owner with a second owner, change your own role to Office, then assert that the role selects and the invite form disappear after `/api/auth/me` returns role `office`.

M3 (deep-link e2e negative check is instant).
In shell.spec.ts 'deep link opens the review directly', use the same pattern as today.spec. Before `page.goto('/approvals/' + scenario.taskId)`, register `const asked: string[] = []; page.on('request', r => { if (r.url().includes('/api/me/today-shown')) asked.push(r.url()); });`. After the review assertions, add `await page.waitForTimeout(1000); expect(asked).toHaveLength(0);`. Then add `await expect(page).toHaveURL('/approvals/' + scenario.taskId);` and keep `await expect(page.getByRole('dialog', { name: 'My day' })).toHaveCount(0);`. Delete the instant `expect(page.url().endsWith('/today')).toBe(false)` line. Do not use `waitForResponse('**/api/me/today-shown')`: with correct code that request is never sent, so the wait would time out.

M4 (switch follow-ups dropped when the menu closes).
In apps/web/src/api/hooks.ts, inside `useSwitchCompany`:
1. Add `const navigate = useNavigate();`.
2. In the hook's `onSuccess`, do the navigation before the reset:
   - `queryClient.setQueryData(keys.me, account);`
   - `void navigate('/');`
   - `return queryClient.resetQueries({ predicate: (q) => q.queryKey[0] !== keys.me[0] });`

Navigating first unmounts the old company's id-based detail queries, so `resetQueries` does not refetch them and get 404s. Only the queries on the map page are refetched.

3. Move the error toast into the hook's `onError`: `const toast = useToast();` and `onError: (error) => toast.show(error.message, 'error')`. `useToast` is available through @roofline/ui and is mounted above the router/shell.

In apps/web/src/shell/topbar/UserMenu.tsx, reduce the call to `switchCompany.mutate(company.id, { onSuccess: close })`, or call `close()` straight away. Remove the `navigate` and `toast` uses that are no longer needed from `MenuList` (`toast` is still used by sign-out).

Add a test: start a switch, close the menu (Esc or Sheet `onClose`) before the request resolves, then check that the route is `/`. Also check that a failed switch with the menu closed still shows the error toast.

**Verify notes:** focused web tests for every file touched, then `slot npx vitest run --project @roofline/web`, `slot npm run typecheck`, `slot npm run lint`, `slot npm run lint:css`, `slot npm run build:web`, `npx playwright test --list -c apps/web/playwright.config.ts`. E2E runs on CI only (ci-check with CI_JOBS="Platform E2E"). Copy rules apply (no literal UI text in JSX; no raw <button>).
