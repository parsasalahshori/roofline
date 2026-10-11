important [7,8]: apps/api/src/app.ts router mounts conflict. T7 adds `app.use('/api/search', searchRoutes(deps)); app.use('/api/map', mapRoutes(deps));` and T8 adds `app.use('/api/weather', weatherRoutes(deps));`, both right after `/api/tasks`. The import lines (mapRoutes, searchRoutes, weatherRoutes) and packages/db/src/index.ts merge cleanly.
 -> Keep all three mounts: /api/tasks, /api/search, /api/map, /api/weather. They must come before T6's `if (config.WEB_DIST_DIR !== undefined) serveWeb(app, config.WEB_DIST_DIR);` and before notFoundHandler. Otherwise the SPA fallback could answer first, though web.ts already skips /api.

minor [7,8]: There are two 'where is this company' rules. T8's companyLocation (repos/location.ts) uses the service area's ST_PointOnSurface, or else the centroid of all non-archived located properties, with no rep scope and no check for an archived customer. T7's mapArea bounds fall back to the extent of the visible (propertyScope) non-archived properties. Both follow the brief, and Ruling J puts companyLocation in location.ts on purpose, but the two now live in separate files with slightly different property filters.
 -> No merge action is needed. Later you can move companyLocation next to mapArea in repos/map.ts, or note the difference (company-wide vs rep-scoped, archived customers counted or not) in the decision log so nobody unifies them by mistake.

minor [6,8]: .env.example is edited by both tasks. T6 adds WEB_DIST_DIR before TWILIO_AUTH_TOKEN and changes APP_ORIGIN to 4401; T8 adds commented-out NWS_USER_AGENT and WEATHER_DISABLED after TWILIO_AUTH_TOKEN. merge-tree auto-merges it cleanly. The styles differ: T6 writes `WEB_DIST_DIR=` uncommented, while T8 comments out its keys. Both work, because loadConfig drops blank values.
 -> No action is needed. After merging, check that the file reads in order: MAIL_FROM, WEB_DIST_DIR, TWILIO_AUTH_TOKEN, NWS_USER_AGENT, WEATHER_DISABLED, TRUST_PROXY.

I simulated the merges with `git merge-tree` and changed no files. Results:
- T6 (83a6b46) + T7 (cc05bc8): merges cleanly.
- T7 + T8 (46778b0): one conflict, in apps/api/src/app.ts (the router mounts). packages/db/src/index.ts auto-merges, because T8's location.ts export sits after jobs and T7's map and search exports sit elsewhere.
- T6 + T8: conflicts in apps/api/src/app.ts (imports), apps/api/src/config.ts (2 hunks) and apps/api/test/config.test.ts (imports). .env.example auto-merges.

Suggested order: T6, then T7 (both clean), then T8, resolving its conflicts by keeping both sides everywhere:
- app.ts imports: keep mapRoutes, searchRoutes, weatherRoutes, `serveWeb` from ./web.ts and `type WeatherSource` from ./weather/source.ts.
- app.ts AppDeps: keeps the `weather: WeatherSource` field; this auto-merges.
- app.ts mounts, in this order: ... /api/tasks, /api/search, /api/map, /api/weather, then the WEB_DIST_DIR serveWeb line, notFoundHandler and errorHandler. Keep T6's `/api/me` mount and the 1 MB approvals parser that sits after the sign-in gate.
- config.ts: keep T6's REPO_ROOT, isBuiltWebApp and webDistDir and T8's `flag`. In the schema, put WEB_DIST_DIR, NWS_USER_AGENT and WEATHER_DISABLED between TWILIO_AUTH_TOKEN and TRUST_PROXY.
- config.test.ts: use the vitest import `{ afterAll, afterEach, beforeAll, describe, expect, test, vi }` plus fs, os, path and T8's buildDeps, InlineQueue, NwsWeatherSource and NullWeatherSource imports.

The interfaces fit together:
- No branch builds AppDeps by hand except deps.ts (T8) and test/helpers.ts makeTestApp (T8). T6's new web.test.ts and me.test.ts use makeTestApp, so they pick up FakeWeatherSource automatically.
- T6's CSP does not affect weather, because NWS is called from the server.
- T6's SPA fallback is mounted after every router and excludes /api, so /api/search, /api/map and /api/weather keep their JSON 404 and 401 answers.
- No web/UI files change in these three tasks, so the copy, raw-<button> and CSS rules do not apply.
- T8's NWS summary strings (for example 'Mostly Sunny') are API data, not UI copy.
- No duplicated helpers. T7 moved the customer matching into search.ts `customerMatch`, which listCustomers now reuses.

After merging, run `/home/user/roofline/ops/bin/slot npm run typecheck` and `slot npm run lint` on the integration branch. Then let CI run the database suites. This matters most for T8, which has no CI run at all: that is its only verify failure, not a code defect. If only apps/api/test/rep-visibility.test.ts:400 fails, it is the known flake; re-run that file alone.
