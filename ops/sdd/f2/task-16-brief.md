### Task 16: Web: Settings (Company and Team)

**Files:**
- Create: `apps/web/src/features/settings/{Settings,CompanyTab,TeamTab,LaterTab}.tsx` (+ CSS Modules), `apps/web/src/copy/settings.ts`
- Modify: `apps/web/src/copy/{connections,billing,setup}.ts`, `apps/web/src/app/router.tsx`, `apps/web/src/api/hooks.ts` (`useUpdateCompany`, `useTeam`, `useInvite`, `useUpdateMember`; it reuses Task 15's `useCompany`)
- Test: `apps/web/test/settings.test.tsx`

**Interfaces:**
- **`/settings`** redirects to `/settings/company`. **`/settings/:tab`**, with tab one of `company`, `team`, `connections`, `billing` or `setup`, renders tabs as links with `aria-current`. An unknown tab redirects to `company`.
- **`CompanyTab`:**
  - **Fields:** name, phone, email, website, street, city, state, ZIP, and time zone (`Select` of the US zones: `America/New_York`, `America/Chicago`, `America/Denver`, `America/Phoenix`, `America/Los_Angeles`, `America/Anchorage`, `Pacific/Honolulu`, `America/Indiana/Indianapolis`, `America/Kentucky/Louisville`, `America/Detroit`, `America/Boise`), plus its current value when it is not in the list.
  - **Owner:** can edit. Save sends a `PATCH /api/company` with only the changed keys (an empty string clears a field). Success → toast "Saved". A 400 with `field` shows the error under that field.
  - **Everyone else:** the same fields, read-only, with the note "Only the owner can change company details."
- **`TeamTab`:**
  - **Members table:** name, email, role, "Can approve spending" (Toggle), and status (Active, or Turned off).
  - **Owner:**
    - changes role (`Select`), spend delegation (Toggle; for office members only) and status ("Turn off" / "Turn back on" Button), each via `PATCH /api/team/members/:id`
    - invites with email plus a role `Select` → `POST /api/team/invites`; success → the toast "Invite sent to {email}"
    - pending invites are listed with their expiry date
    - API errors (`lastOwner`, `alreadyOnTeam`, `verifyEmailFirst`) show in a toast or under the field
  - **Others:** a read-only list without invites.
- **`LaterTab({ tab })`:** connections, billing and setup each show an `EmptyState` with their copy from `copy/connections.ts`, `copy/billing.ts` and `copy/setup.ts` (for example "Connect your Google and Facebook ad accounts here. Coming with setup."). These files are where vendor names are allowed.
- **Role labels:** owner "Owner", office "Office", rep "Field rep". They live in `copy/settings.ts` and are passed to the `Select`s.

- [ ] **Step 1: Write the failing tests** (`settings.test.tsx`):
  - `it('owner saves only what changed')`: change the phone → the PATCH body is exactly `{ phone: '…' }`.
  - `it('shows the field error from the server')`: 400 with `field:'website'` → the error under Website.
  - `it('office sees read-only company details')`: the inputs are read-only, the note is shown, and there is no Save button.
  - `it('owner invites a teammate')`, `it('owner turns on spend approval for an office member')`, `it('last owner error shows as a toast')`.
  - `it('later tabs say what is coming')`: `/settings/billing` shows the billing copy.
  - `it('unknown tab goes to company')`.
- [ ] **Step 2: Run them and see them fail**.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run the tests, the lints and the build**. Expected: PASS, including the copy-rules test with the new vendor strings.
- [ ] **Step 5: Commit** — `feat(web): settings for company details and team`

---

