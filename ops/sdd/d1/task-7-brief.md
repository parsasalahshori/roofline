### Task 7: Tools — caller, jobs, forecast, hail

**Base:** `d1-front-desk` after Tasks 3 and 4 are merged. Real (F1/F3): `customers.phones` (jsonb `CustomerPhone[]`, GIN), `weather/source.ts` (`WeatherSource { current(lat, lng) }` only — this task adds `daily`), `weather/nws.ts`, `NullWeatherSource`, test `FakeWeatherSource`. **[C1]** job stage words and next appointment (C1 T8 `listAppointmentsForCustomer`). **[E1]** proposal status (`proposals`, `proposal_events`; E1 T8 `getProposal`). **[S1]** `storm_hits` (S1 T9).

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

**Split:** Builder 1 `repos/fd-caller.ts` + `tools/caller.ts` (match by phone at start; `verify_caller`); Builder 2 `tools/jobs.ts` (`lookup_my_jobs`: plain stage words, next appointment, rep first name, E1 proposal state; verified only, matched callers hear only "you have an appointment on Thursday") + `tools/hail.ts` (S1 `storm_hits` for the caller's homes, last 30 days); Builder 3 `weather/{source,nws}.ts` `daily(lat, lng, days)` (NWS `/points` → `forecast` periods; null on failure) + fake + `tools/forecast.ts` + tests.

**Files:** Fill the listed files; Modify `apps/api/src/weather/{source,nws}.ts`, `apps/api/src/providers/fakes/weather.ts` (or wherever F3's fake lives); Test `apps/api/test/front-desk/tools-info.test.ts`.
- **Tool results for the model** are short plain sentences with ids only where a later tool needs them (`shownIds`), e.g. `"Job a1b2… at 123 Elm St: waiting on the customer's signature; proposal sent Oct 6, opened Oct 7. Next: none."`.

**Tests:**
- match one/two/no customers; verification success/failure (three failures → transfer suggestion in the result); unverified job lookup gives only the day of the next appointment; forecast null → "I can't reach the forecast right now"; hail result says "radar-estimated"; another company's customer with the same phone is never matched.

**Carries and rulings:**
- **Ruling DC** (see T4): `WeatherSource` gains `daily(lat, lng, days)`; `NullWeatherSource` returns null.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): Front Desk tools for knowing the caller, their jobs, the forecast and hail`
