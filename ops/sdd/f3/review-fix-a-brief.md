### F3 integration review fixes, group A: Web fixes (billing errors, plan picker, map refresh, skipped-rows download, texting approved without a number)

**Base:** f3-setup 330ca23 (branch f3-review-a). Source: the F3 integration review (sibling 3, workflow wf_4ad50b4d-a20); each finding below was verified by an Opus verifier against the code. Apply the VERIFIED FIX (it supersedes the reviewer's first proposal). Keep changes minimal and inside the files named. Add the tests named. Ruling AO: no new migrations.


## R1 (web-api-contracts/W1; verdict confirmed, important; tasks T34 (import wizard summary), T30 (router and link adapter))

**Where:** apps/web/src/app/providers.tsx:22-24 (used by apps/web/src/features/imports/ProgressStep.tsx:57-60)

**Problem:** The skipped-rows download is a Button with href and the download attribute. The Button renders through UiLink, and the app's RouterLink adapter turns it into react-router's Link. In react-router 7.18 the Link click handler calls preventDefault and navigate() for every plain left click, and it never checks the download attribute. The click becomes a client-side navigation to /api/imports/:id/skipped.csv, so the browser never requests the file.

**Failure scenario:** An import finishes with skipped rows, so skippedDownloadUrl is '/api/imports/<id>/skipped.csv'. The owner clicks 'Download skipped rows'. The router matches '/api/imports/<id>/skipped.csv' against its catch-all and shows the NotFound window, and no CSV downloads. The spec's downloadable skipped-rows CSV cannot be reached from the UI. The wizard test only asserts that the link has a download attribute, so it passes.

**Verifier:** I traced the code and the finding holds. ProgressStep.tsx:58 renders `<Button href={skippedDownloadUrl} download>`. Button passes it to Pressable, Pressable to UiLink (packages/ui/src/link.tsx), and UiLink to RouterLink (apps/web/src/app/providers.tsx:22-24), which is a bare react-router `<Link to={href} {...rest}/>`.

In react-router 7.18.4 (node_modules/react-router/dist/development/chunk-OB3PAWPO.mjs), the link counts as an SPA link because `isSpaLink = !(parsed.isExternal || reloadDocument)` and a relative `/api/...` path is not external. So the anchor's onClick is handleClick. Pressable's onClick does not call preventDefault for an active link, so handleClick goes on to internalOnClick. `shouldProcessLinkClick` (line 7431) checks only the mouse button, the target and modifier keys. It never looks at `download`. A plain left click therefore runs preventDefault and then navigate('/api/imports/<id>/skipped.csv').

The API serves the file at GET /:id/skipped.csv (apps/api/src/routes/imports.ts:236), but the client router sends the path to its `*` catch-all (apps/web/src/app/router.tsx:74), which shows NotFoundWindow. No CSV downloads.

The proposed fix works. With `reloadDocument`, isSpaLink is false, so the anchor gets the caller's onClick (Pressable's, which does not call preventDefault when the link is active) and the browser handles the download natively.

**VERIFIED FIX:** In apps/web/src/app/providers.tsx, change RouterLink so that download links skip client-side navigation:
`function RouterLink({ href, ...rest }: UiLinkProps) { const isDownload = rest.download !== undefined && rest.download !== false; return <Link to={href} reloadDocument={isDownload} {...rest} />; }`

Add a test in the web app with Providers and a memory router. It should render `<Button href="/api/imports/x/skipped.csv" download>` and fire a left click. Assert that the click event is not default-prevented: `fireEvent.click` returns true, or `createEvent` followed by `event.defaultPrevented === false`. Also assert that the router location did not change. Include a control case: a plain link without `download` still gets its click default-prevented.


(Same issue also reported as copy-a11y/W1; its verified fix for reference: In apps/web/src/app/providers.tsx, change RouterLink so a download link, or any link to a server path, does a normal document request instead of an SPA navigation: `function RouterLink({ href, ...rest }: UiLinkProps) { const reloadDocument = rest.download !== undefined || href.startsWith('/api/'); return <Link to={href} reloadDocument={reloadDocument} {...rest} />; }`. With `reloadDocument`, Link drops its click handler (isSpaLink=false), so the browser honours `download` and the server's Content-Disposition. Add a test to apps/web/src/features/imports/import-wizard.test.tsx, or to a providers test. Render the summary state with a skippedDownloadUrl inside a MemoryRouter or createMemoryRouter plus Providers. Then fireEvent.click (or userEvent.click) the "Download skipped rows" link and assert that the router location is unchanged (for example, that a location probe still shows the settings path and NotFoundWindow does not render). The test should also assert that the anchor still has the `download` and `href` attributes.)


## R2 (web-api-contracts/W2; verdict confirmed, important; tasks T33 (billing web) against T19 (billing routes))

**Where:** apps/web/src/features/billing/PlanPicker.tsx:14 (also BillingTab.tsx:79 and ShellBanners.tsx:34)

**Problem:** PlanPicker's onError is `() => toast.show(errors.generic, 'error')`, which discards the server's plain-English {error}. The checkout route answers 403 'Please confirm your email first. We sent you a link.' (requireVerifiedEmail), 409 'You already have a plan. Use Change plan.', and 503 "Billing isn't set up yet." or 502 for provider trouble. The portal mutations in BillingTab and in the past_due ShellBanners button pass no onError at all, so their failures are silent.

**Failure scenario:** A new owner signs up, which leaves the email unverified, opens Settings > Billing and clicks 'Pick this plan'. POST /api/billing/checkout returns 403 with the confirm-your-email message. The screen shows 'Something went wrong. Please try again.' Retrying always fails, and nothing on this screen says why or how to fix it. For a past_due owner, 'Fix payment' does nothing visible when the portal call fails.

**Verifier:** Confirmed in the code. In /home/user/wt/f3-review/apps/web/src/features/billing/PlanPicker.tsx:14 the handler is `const onError = () => toast.show(errors.generic, 'error')`, which throws away the error. useCheckout, usePortal and useChangePlan in features/billing/api.ts have no onError of their own, and the app has no global MutationCache onError (grep finds none). The portal.mutate() calls at BillingTab.tsx:79 and ShellBanners.tsx:34 pass no handler, so a failed portal call shows nothing at all.

On the server, apps/api/src/account/billing-routes.ts:98 mounts `requireVerifiedEmail` on POST /checkout. That guard (auth/middleware.ts:103) returns 403 with MESSAGES.verifyEmailFirst. The web shell has no "confirm your email" banner (grep finds only the VerifyEmail page), so the plan picker is the only place an unverified owner could learn why checkout fails.

Failure path: an owner signs up with email and password and has not confirmed the address yet. They click "Pick this plan" and see "Something went wrong. Please try again." Every retry fails the same way, and nothing tells them to confirm their email. The 409, 503 and 502 billing messages are lost the same way. For a past_due owner, a failed "Fix payment" click shows nothing.

apiFetch (api/client.ts) always throws ApiError with a plain-English message, and network failures become ApiError(0, common.networkError), so error.message is always safe to show. UserMenu.tsx:104 already uses that pattern. Neither the T33 brief nor the ledger asks for the generic text or defers this.

**VERIFIED FIX:** Show the server's message everywhere a billing mutation can fail.

Simplest version: in apps/web/src/features/billing/PlanPicker.tsx:14, change the handler to `const onError = (error: Error) => toast.show(error.message, 'error')`. apiFetch always throws ApiError with plain text, so the `instanceof ApiError ? error.message : errors.generic` guard is also fine. In BillingTab.tsx:79 and ShellBanners.tsx:34, call `portal.mutate(undefined, { onError: (error) => toast.show(error.message, 'error') })`, getting `toast` from `useToast()`.

Alternative: put `onError: (error) => toast.show(error.message, 'error')` inside useCheckout, usePortal and useChangePlan in features/billing/api.ts, calling useToast in each hook, and drop the per-call handlers.

Tests to add in the billing web tests:
- Stub POST /api/billing/checkout to return 403 `{ error: 'Please confirm your email first. We sent you a link.' }`. Click "Pick this plan", assert that exact text appears as a toast, and assert that go.assign was not called.
- Stub POST /api/billing/portal to return 502 `{ error: 'X' }` while status is past_due. Click "Fix payment" and assert the toast shows 'X'.


## R3 (billing/B2; verdict confirmed, important; tasks T33/T20 (P3b))

**Where:** apps/web/src/features/billing/PlanPicker.tsx:21

**Problem:** `current = plan.key === view.planKey` shows the plain Your plan label with no button, whatever the company status. When a subscription is deleted, T20/P3b sets status=canceled and clears stripe_subscription_id but keeps plan_key. So BillingView.planKey still names the canceled plan. The API explicitly lets a canceled company check out again (billing-routes.ts checkout comment and hasPaymentMethod), but the UI offers no way to check out the plan they already had.

**Failure scenario:** A company on plan growth cancels, or its subscription is deleted after failed payment retries. The read-only banner says Pick a plan to keep going and links to Settings, Billing. The Growth card says Your plan with no button, because planKey is still growth, so the owner cannot re-subscribe to the same plan. They must buy a different plan or use Invoices and card. Trial_ended companies with a stale plan key get the same dead end.

**Verifier:** I traced the failure path in the code and it holds. In apps/web/src/features/billing/PlanPicker.tsx:21, a card counts as current (`current = plan.key === view.planKey`) without checking status. When that is true, the card shows the "Your plan" text and no button. The plan key is only written by Stripe subscription events (stripe-events.ts subscriptionUpdate, through planKeyFor). Nothing clears it. On customer.subscription.deleted (stripe-events.ts:115-121), the update sets only status 'canceled' and stripeSubscriptionId null, so planKey survives. A status of incomplete_expired also maps to canceled through subscription.updated and keeps the plan key. GET /billing (billing-routes.ts:82,85) then returns planKey set to the old plan and hasPaymentMethod false. POST /checkout (billing-routes.ts:102-105) explicitly allows a canceled company to check out again. The canceled company is read-only, and ShellBanners sends the owner to Billing with "Pick a plan to keep going". There, the plan they had shows "Your plan" with no button. The only ways to keep that plan are to buy a different one or go through the Stripe portal. The billing view does not let them re-subscribe to the plan they had. Trial companies are not affected, because sign-up never sets plan_key; only Stripe events do. The same case is not in the ledger's deferred minors. The proposed fix is correct and matches the server's own rule (hasPaymentMethod is true only for active or past_due with a subscription).

**VERIFIED FIX:** In apps/web/src/features/billing/PlanPicker.tsx:21, change the line to `const current = view.hasPaymentMethod && plan.key === view.planKey;`. A canceled or trial_ended company then gets "Pick this plan", which runs checkout, on every card, including its old plan. An active or past_due company keeps "Your plan" on its plan and "Switch" on the others. Optionally update the comment on line 8 to say the company's own plan says so only while the subscription is live. Add a case to apps/web/test/billing.test.tsx: render the Billing tab with a BillingView of status 'canceled', planKey 'growth', hasPaymentMethod false. Assert that the Growth card shows a "Pick this plan" button and no "Your plan" text. Assert that clicking it POSTs /billing/checkout with { planKey: 'growth' }. Keep or add the opposite case: status 'active', hasPaymentMethod true, planKey 'growth' still shows "Your plan" on Growth.


(Same issue also reported as web-api-contracts/W3; its verified fix for reference: 1. apps/web/src/features/billing/PlanPicker.tsx:21: change the line to `const current = view.hasPaymentMethod && plan.key === view.planKey;`. A canceled, trial_ended, or never-subscribed company then sees "Pick a plan" (checkout) on every plan, including its old one. A live company (active or past_due with a subscription) still sees "Your plan" on its own plan and "Switch plan" on the others.

2. Optional, for consistency: apps/web/src/features/billing/BillingTab.tsx:72. Show billing.noPlan instead of data.planName when !data.hasPaymentMethod, or when status is 'canceled' or 'trial_ended'. The status line under the name already says Canceled, so this part is cosmetic.

3. Add apps/web/src/features/billing/PlanPicker.test.tsx (vitest + Testing Library, wrapped in QueryClientProvider and the ui ToastProvider). Render PlanPicker with view = { status: 'canceled', planKey: '<plan A key>', hasPaymentMethod: false, plans: [A, B], ... }. Assert that the card for plan A has no "Your plan" text and has a "Pick a plan" button, and that clicking it calls the checkout mutation with A's key. Add a second case with { status: 'active', planKey: A, hasPaymentMethod: true }: card A shows "Your plan", and card B shows the "Switch plan" button.)


## R4 (web-api-contracts/W5; verdict confirmed, important; tasks T32 (Setup sheet) with the F2 map (keys.mapArea, staleTime 5 min) and T15 (locate and service-area routes))

**Where:** apps/web/src/features/setup/api.ts:37-41 and 48-52

**Problem:** useLocateCompany and useServiceArea invalidate keys.company and setupKey but not keys.mapArea. The shell map reads /api/map/area, which returns the company's service-area polygon and bounds, with staleTime 5 minutes. The map stays mounted behind every window, so it never remounts and refetches.

**Failure scenario:** An owner signs up with an address the geocoder could not place (Ruling AN), so the map area is empty. In Setup they click 'Place on map', or they change the radius from 40 to 20 miles. The API stores the new point and area and the sheet says 'Your company is on the map'. The map behind it still shows no area, or the old radius, until a reload or a focus refetch after the 5-minute stale time.

**Verifier:** The bug is real. In apps/web/src/features/setup/api.ts, useLocateCompany (lines 38-41) and useServiceArea (lines 49-52) only invalidate keys.company and setupKey. The shell map reads useMapArea() (apps/web/src/api/hooks.ts:95-101, key keys.mapArea, GET /api/map/area, staleTime 5 min). MapView is mounted once in Shell.tsx:92-96 behind the windows. It is keyed only by companyId, so opening the Setup sheet never remounts it. Both routes change what /api/map/area returns. POST /api/company/locate (apps/api/src/routes/company.ts:273-307) calls setCompanyLocation with a new point and service-area radius. PUT /api/company/service-area (310-331) calls setServiceAreaRadius. MapView already reacts when area.data changes: it calls fitBounds at lines 115-118 and updateMapData at 121-131. So a refetch is all that is missing. Without it, the 5-minute staleTime keeps the old (empty or old-radius) area: a window-focus refetch does nothing while the data is fresh, and the map never remounts. The realistic path: an owner signs up with an address the geocoder could not place (Ruling AN), opens Company basics in Setup, and clicks place-on-map or changes the radius. The sheet reports success, but the map behind it shows no area or the old circle and does not fit the bounds, for up to 5 minutes or until a reload. This is not in the ledger's deferred minors. It stays Important: the visible result of the setup item contradicts its success message right where the owner is looking.

**VERIFIED FIX:** apps/web/src/features/setup/api.ts: in the onSuccess of both useLocateCompany and useServiceArea, add `void queryClient.invalidateQueries({ queryKey: keys.mapArea });` next to the existing keys.company and setupKey invalidations. keys is already imported. Test: in apps/web/test/setup.test.tsx (or a hook test with a QueryClient), seed keys.mapArea with stale-free data, spy on queryClient.invalidateQueries (or check getQueryState(keys.mapArea).isInvalidated), run the locate mutation and the service-area mutation against mocked fetch 200 responses, and assert that keys.mapArea was invalidated each time.


## R5 (texting-registration/TX-5; verdict confirmed, important; tasks T35, T27)

**Where:** apps/web/src/features/texting/TextingStatus.tsx:21

**Problem:** The screen renders nothing when state is 'approved' but view.number is null. The API returns exactly that state: campaign_status 'approved' is set before a number exists, and number is the company's active main number or null. The T28 brief buys the number only while the company status is 'active', so a past_due company, or one waiting for the next job pass, has no number. TextingStatus returns null, so the Settings window shows a blank subpage. SetupRow also shows no action, so the owner has no way to find out what is happening.

**Failure scenario:** Campaign approved, company is past_due or the number purchase has not run yet. GET /api/texting returns state 'approved', number null. TextingSetup renders TextingStatus, which returns null: an empty page with no message.

**Verifier:** The failure path is real. In apps/api/src/account/texting/view.ts:72-73 and 116, campaign_status 'approved' maps to state 'approved' with no check on the number, and `number` comes from the company's active 'main' row in company_phone_numbers (loadTextingCompany, lines 45-56). That value is null until a number is bought. TextingSetup.tsx:40 sends every 'waiting' or 'approved' state to TextingStatus. TextingStatus.tsx:21 only renders when number is not null, and line 28 otherwise returns null, so /settings/setup/texting shows an empty page with no message.

The number purchase belongs to T28, which is not merged at 330ca23 (ledger line 86: "Left: T28, T37, then T36"). So on this branch every approved company gets the blank page. After T28 lands, it still happens in two cases. A past_due company gets it for as long as it stays past_due, because of the controller carry at ledger line 52 (T28 buys only when the company is 'active'). Any company also gets it between approval and the next job pass.

The ledger does not list this as a deferred minor. The T35 brief (line 26) only describes approved-with-number and does not cover the null case.

One detail in the finding is not right: SetupRow does not hide the action because of this state. Its texting_registration case only drops the button for 'waiting'. The main problem, the blank settings subpage, stands either way.

**VERIFIED FIX:** Make three changes and add one test.

1. In apps/web/src/copy/texting.ts, add a plain-language line, for example `gettingNumber: "You're approved. We're getting your texting number ready."`

2. In apps/web/src/features/texting/TextingStatus.tsx, replace the final `return null` with an approved-without-number branch: `if (view.state === 'approved') return <Card className={styles.card}><p className={styles.line}>{texting.gettingNumber}</p></Card>;`. Keep the existing branch for approved with a number. The component should only return null for states that are never routed to it.

3. Optional: if `view.needsPaymentMethod` is true in this branch, also show `texting.needsCard`/`addCard` (or an equivalent "update your card" note). A past_due company will not get a number until it pays, so this tells the owner why.

Test: in apps/web/test/texting.test.tsx, add `it('shows approved without a number yet')`. Render TextingSetup with a mocked GET /api/texting returning state 'approved' and number null. Assert the new copy appears and the page is not empty.
