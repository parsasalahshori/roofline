# Task 16 report: Web Settings (Company and Team)

Status: DONE
Worktree: `/Users/parsasalahshori-a/RooflineWork/wt/t16`, branch `f2-t16` (base f2-shell 1fb5bd7)
Commit: `57f9715 feat(web): settings for company details and team` (14 files, +1480 / -2)

## What was built, by package

**Shared (hooks, tabs, words)**
- `features/settings/api.ts`: `useCompany` (GET /api/company, key `keys.company`; Task 15 reuses it from here, Ruling Q), `useUpdateCompany` (PATCH; puts the saved company in the cache and asks for the session again without waiting), `useTeam`, `useInvite`, `useUpdateMember` (both refresh the team). `api/hooks.ts` was not edited.
- `features/settings/tabs.ts`: the five tab keys, `isSettingsTab`, `LaterTabKey`.
- `copy/settings.ts`: tab names, role labels (Owner, Office, Field rep), the Company and Team words, the eleven US time zones.
- `copy/connections.ts`, `billing.ts`, `setup.ts` already had a `later` string from Task 2, so they were reused as they are (not modified). Vendor names (Google, Facebook, Stripe) stay only in those files.

**Package A (Settings window, routing, later tabs)**
- `Settings.tsx` + `Settings.module.css`: tab links (`Button` with `href`), `aria-current="page"` on the current tab only, an unknown tab redirects to Company, and the panel is keyed by tab so typed text and saved state reset when another tab opens.
- `LaterTab.tsx`: an `EmptyState` with the `later` line of connections, billing or setup.
- `app/router.tsx` (5 insertions, 2 deletions): `settings` redirects to `/settings/company`; `settings/:tab` renders `<AppWindow app="settings"><Settings /></AppWindow>`. The catch-all comment now says only Task 15 (today) is still to come.
- Tests: `test/settings.test.tsx` (8): later tabs, connections, setup, unknown tab, `/settings`, five tab links with `aria-current`, opening a tab from its link, window titled Settings.

**Package B (Company tab)**
- `CompanyTab.tsx` + css: name, phone, email, website, street, city, state, ZIP and a time zone `Select` (US zones, plus the current value when it is not in the list). The owner saves only the changed keys (an empty string clears a field); success shows the toast "Saved"; a 400 with `field` shows under that field (time zone too). Everyone else sees the same fields read-only, the note "Only the owner can change company details.", and no Save button.
- Tests: `test/settings-company.test.tsx` (10): owner saves only what changed, save is off until something changes, a failed background refresh keeps what was typed, an emptied field is sent as an empty string, a changed time zone is sent, field error from the server, an error without a field becomes a toast, office sees read-only details, time zone list keeps an unlisted value, owner sees the company's details.

**Package C (Team tab)**
- `TeamTab.tsx` + css (with a non-exported `MemberRow`): members table (name, email, role, can approve spending, status). Owner: role `Select`, spending `Toggle` for office members only (owners show "Always", field reps "Never"), "Turn off" / "Turn back on" button, invite form (email and role, toast "Invite sent to {email}"), pending invites with their expiry date; errors (`lastOwner`, `alreadyOnTeam`, `verifyEmailFirst`) show in a toast or under the email field. Everyone else gets a read-only list without invites.
- Tests: `test/settings-team.test.tsx` (11): spend approval for an office member, role change, turn off and back on, invite, last owner toast, a refused change still reported when another follows at once, refused invite toast, email problem under the field, pending invites with expiry, office read-only list, only office members get a spending switch.

## Review rounds

The finding texts were not part of the inputs given to the finalizing agent (as in the Task 12 report), so only the outcomes handed over are recorded. The fixes were already in the working tree when it was finalized.

- Round 1: verify passed, 2 findings. Opus contact check: F1 amended, F2 approved. Both fixed.
- Round 2: verify passed, 1 finding. Contact check: R2-1 approved. Fixed.
- Round 3: verify passed, 0 findings. Clean; no further fixes.
- Rejected: none.

## Minors / judgment calls carried forward

- Company form keeps a `baseline` state (set on mount, and to the saved company after a save) instead of comparing with the latest query data. A window-focus refetch that changes one field would otherwise make an untouched field look changed and send it back, overwriting someone else's edit. Same results in the 9 original tests.
- Time zone `Select` also shows a server field error for `timezone` (not in the brief).
- Company and Team: the `EmptyState` with Try again shows only while there is no data yet (first load failed). A background refetch that fails after data has loaded keeps the form and what was typed (this replaced Builder 2's first version, which swapped the form for the EmptyState; covered by 'a failed background refresh keeps what was typed'). Retry refetches both the session and the company, or the session and the team.
- A field error from a failed company save stays under its field until the next submit.
- Invite role stays at the owner's pick after a successful invite; only the email is cleared.
- The brief's combined connections/setup test was split into two tests (the brief allowed this).
- The brief listed `copy/{connections,billing,setup}.ts` and `api/hooks.ts` as modified; neither needed changes (existing `later` strings; hooks moved to `features/settings/api.ts` by Ruling Q).
- Task 15 must import `useCompany` from `features/settings/api.ts`.
- Merge: `app/router.tsx` is a conflict candidate with Task 14 (it replaces the approvals placeholders in the same route list) and Task 15 (today).
- The production build warns that the main chunk is 1.5 MB; that is the existing item assigned to polish task P1 (Ruling O, lazy-load MapView), not new from this task.
- Commit trailer is `Co-Authored-By: Claude Sonnet 5.5` (the session's attribution rule).
- Verify was run on the final working tree, as one `&&` chain, exit code 0.

## Verify output (from the worktree root, after the final changes)

```
npx vitest run --project @roofline/web
 Test Files  21 passed (21)
      Tests  232 passed (232)
   Duration  19.27s

npm run lint        (eslint .)                        clean
npm run lint:css    (stylelint)                       clean
npm run typecheck   (tsc -b)                          clean
npm run build:web   (vite build)
  dist/index.html                     0.39 kB | gzip:   0.26 kB
  dist/assets/index-Bal99M1Y.css     90.19 kB | gzip:  14.93 kB
  dist/assets/index-Dw3J2p73.js   1,527.47 kB | gzip: 426.83 kB
  (!) Some chunks are larger than 500 kB after minification.
  built in 946ms
```

## Team review finalization

- Review 1: verify passed, 0 findings. No fixes needed; no new commit (HEAD stays 57f9715).
- Minors: none.
- Verify: web vitest 21 files / 232 tests passed; typecheck, lint, lint:css clean.
- CI: ci-check run 38177661416 PASSED (platform job) for f2-t16@57f9715.
