# Merge notes: sibling 3, group G5 (F3 Tasks 25, 29, 30)

Session session_01RypesnL2fbawyJH5HtdS7E (Ruling S). All three start from f3-setup 7b988eb. Only the Platform CI job is judged.

| Branch | Head | Workflow | Review | CI (Platform) |
|---|---|---|---|---|
| `f3-t25` | a7b87ca | wf_ec371b0c-ed1 (contact 48) | round 1 clean | 38186241296: success |
| `f3-t29` | 0f641cb (42222d3 + ring fix) | same | round 1 clean | 38187712062: success |
| `f3-t30` | 9889bb3 (593911c + CSS fix) | same | round 1 clean | 38187712022: success |

## Merge order

No file overlap among the three, so expect no conflicts. Suggested order: T29, then T30, then T25.

## T25: Twilio registrar

- **Files:**
  - `providers/twilio/accounts.ts`
  - `apps/api/test/twilio-fixtures.ts`
  - 10 fixtures under `test/fixtures/twilio/`
  - `test/twilio-accounts.test.ts`
- **Ruling AD (for T26 and T28):**
  - `fixtureFetch(routes)` is general-purpose. A route value can be a fixture name, a list of names (the last one repeats), or inline JSON starting with `{`.
  - An unmatched route rejects inside fetch, so `TwilioHttp` reports it as `TwilioUnreachableError`.
- **Minors:**
  - `ensureNumber`: if the purchase succeeds but attaching the number to the service fails, a retry buys a second number.
  - An empty-string areaCode or state is sent as a filter, where it should be treated like null.
  - `accounts.ts` and `registrar.ts` import each other; this is safe because the values are used only at call time.
  - `ensureMessagingService` reads only the first page of services.

## T29: Design kit additions

- **Props:**
  - `Banner { tone: 'info'|'warning'|'danger'; children; action? }`
  - `ProgressRing { done; total; label; size?: 24|32 }`
  - `ProgressBar { value; max; label }`
  - `Checkbox { checked; onChange(next); label; description?; error?; disabled?; ref? }`
  - `FilePicker { label; buttonLabel; dropLabel; accept; onFile(file); help?; error?; busy? }`
- **Fix after the group check (0f641cb):** a ring with `total` 0 is not marked complete. A test covers it.
- **Minors:**
  - FilePicker still calls `onFile` for a file dropped while `busy`.
  - Some behaviours in the brief have no tests: the input reset, dragleave, and the aria-describedby links.

## T30: Web skeleton

- **Files:** the F2 hotspots (`router.tsx`, `Settings.tsx`, `tabs.ts`, `LaterTab.tsx`, `Shell.tsx` with its CSS, `UserMenu.tsx`), eight placeholders, the copy files (`import.ts`, `texting.ts`, plus `comingSoon` in `auth.ts`), five empty `api.ts` files, and `test/f3-routes.test.tsx`. Web vitest: 34 files, 350 tests passed.
- **Rulings:**
  - AG: the Billing and Setup placeholders reuse `billing.later` and `setup.later`.
  - AH: the banner slot's measured height adds to `--shell-top-inset`.
  - W: the `useTodayAutoOpen()` line is kept.
- **Fix after the group check (9889bb3):** deleted the duplicated `--shell-bottom-inset: 94px;`.
- **Notes for T32 and T33:**
  - `.banners` has the same z-index (25) as `.topBar` and comes after it, so UserMenu popovers could paint under a real banner. Give `.banners` z-index 24 when ShellBanners gets content.
  - `UserMenu.module.css .root` may need flex if SetupRing sits inline.
  - The banner-height offset is untested because jsdom has no ResizeObserver; T32 or T33 should cover it.
- **Minors:**
  - In `Settings.tsx`, the `renderPanel` type duplicates `SettingsTab`.
  - The billing, setup and connections route tests look for text anywhere on the page, not inside the Settings dialog.
- **Not in f3-setup when this was built:** F2 T18 (e2e). F2 is complete on `f3-setup` dd689aa now; T30 does not touch `apps/web/e2e`.
