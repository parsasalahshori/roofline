# F3 Task 30 report: Web skeleton for the F3 screens

Commit 593911c on f3-t30. CI run 38186908137: PASSED.

## Built
- p1-routing-settings: router.tsx (public /sign-up; settings/setup/import, settings/setup/import/:importId, settings/setup/texting before settings/:tab, each in AppWindow app="settings" with Settings subpage), Settings.tsx (optional subpage prop, billing -> BillingTab, setup -> subpage ?? SetupTab), tabs.ts (LaterTabKey = 'connections'), LaterTab.tsx (connections only).
- p2-shell-slots-placeholders: Shell.tsx banner slot (ShellBanners, ResizeObserver height, --shell-banner-height; useTodayAutoOpen() line kept), Shell.module.css (--shell-base-top, --shell-top-inset = base + banner height, .banners), UserMenu.tsx (SetupRing slot), placeholders SignUp, SetupTab, SetupRing, BillingTab, ShellBanners, ImportWizard, TextingSetup (EmptyState with existing copy per Ruling AG), copy/import.ts, copy/texting.ts, auth.ts additions, features/*/api.ts.
- p3-tests: apps/web/test/f3-routes.test.tsx (seven route cases).

## Review rounds
- Round 1: verify passed, 0 findings.

## Minors
- UserMenu.module.css unchanged; the task that fills SetupRing should add `display:flex; align-items:center; gap:8px` to .root if the ring sits inline.

## Verify tail
typecheck, lint, lint:css clean; web vitest: 34 files, 350 tests passed.
