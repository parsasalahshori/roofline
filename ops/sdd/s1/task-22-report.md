# Task 22 report: Web skeleton (Storm routes, dock flag, settings slots, copy)

## Built
- A-routes-dock: router.tsx (storm/routes, storm/routes/:routeId, storm/:id, each in AppWindow app="storm"; coming-soon storm/* removed), shell/apps.ts storm shipped:true, c1/e1 route tests updated.
- B-settings-slots: tabs.ts + Settings.tsx storm tab (owner/office only, rep redirected to /settings/company), StormTab.tsx, AdConnections slot (Card + CSS Module) in ConnectionsTab.tsx, copy/settings.ts, settings.test.tsx.
- C-placeholders-copy-test: StormDetail, RoutesWindow, RouteDetail, api.ts files, copy/storm.ts, doors.ts, ads.ts, connections.ts, s1-routes.test.tsx.

## Reviews
- Review 1: verify passed, 0 findings.

## Minors
- StormTab.module.css not needed, not created.

## Verify tail
typecheck, lint, lint:css clean; vitest @roofline/web: 46 files, 457 tests passed.
