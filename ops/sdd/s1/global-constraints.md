## Global Constraints (S1 Storm Scout)

Adapted from `ops/sdd/c1/global-constraints.md` and `ops/sdd/e1/global-constraints.md` (which carry F1–F3's rules) and the plan's Global Constraints (`docs/superpowers/plans/2026-10-12-roofline-storm-scout.md`). Spec: `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Branch `s1-storm` from `e1-estimator` once E1 is merged; task branches `s1-t<N>`. S1 rulings use the prefix **S** (SA, SB, …).

**C1 and E1 are not built yet.** Names marked **[C1]** / **[E1]** in a brief come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`). The lead checks each against the merged branch before starting and records any difference in the report; a renamed export is followed, not re-created.

**Everything in the C1 and E1 global constraints applies**, with these S1 changes:
- **Migrations:** S1 owns `0017_storm_schema.sql` (generated) and `0018_storm_grants_rls.sql` (custom) (Ruling AP; the plan's 0016/0017 are superseded), both in Task 1, including the new `app_hail` role. E1 ends at `0016` (Ruling AP).
- **Lockfile:** only Task 1 edits `package-lock.json` (`@resvg/resvg-js`).
- **Python service (`services/hail/`):** Python 3.10 (Ruling SJ: the GDAL `ubuntu-small-3.8.5` image is Ubuntu 22.04; no `datetime.UTC`, `tomllib`, `typing.Self`, `StrEnum`, `except*`; ruff target py310), GDAL from the `ghcr.io/osgeo/gdal:ubuntu-small-3.8.5` image (`osgeo` bindings, never pip-installed), `psycopg` 3, `shapely` 2, `httpx`; dev extras `pytest`, `ruff`. **Nothing Python runs on the build box.** Verify = `ruff check .` and `pytest -q` in `services/hail`, run by the CI `hail` job (added in Task 2, Ruling SG; full YAML in the T2 brief); prove with `CI_JOBS="Platform Hail" ops/bin/ci-check`. The job runs `npm run db:migrate` against a `postgis/postgis:16-3.4` service on port 54329, then pytest inside the GDAL image with `HAIL_TEST_DATABASE_URL`.
- **No `render.yaml`** exists in the repo; the hail worker's Render setup is documented in `services/hail/README.md` (Ruling SB, owner step).
- **Step handlers** register in `apps/api/src/tasks/handlers.ts` (`builtInHandlers`); each feature task swaps only its own stub.

**From the plan (verbatim):**
- **Everything in C1's and E1's Global Constraints applies** (TypeScript/ESM, `enumCheck`, tenant tables with forced RLS and composite FKs, `app_system` column grants plus `app_system_all`, no raw queries from routes, `{error, field?}` errors with module-constant messages, secrets only from `config.ts`, copy rules, hooks in `features/<feature>/api.ts`, no third-party UI library, 12px / AA / 40px / 375px, company time zone, integer cents).
- **Global hail tables** (`hail_runs`, `storms`, `storm_contours`, `spotter_reports`) carry no tenant data: `app_tenant` SELECT only; `app_hail` writes the first three; `app_system` writes `spotter_reports`.
- **`@roofline/db/system`** is allowed in `apps/api/src/jobs/scheduler/**` (storm-match and ad-spend-sync fan-outs) and `apps/api/src/public/**` (landing page code → company; unsubscribe token → company).
- **"Radar-estimated"** labels every hail size in the app, the alert email, the plan preview and the map legend (master §9.2). Customer texts and emails say "Radar shows hail up to …".
- **No owner names** for non-customer homes anywhere (master §3.1); route stops show an address and nothing else.
- **Every outbound customer text goes through `send_sms_batch` and the F1 gate; every storm email through `decideEmail`.** Nothing calls an adapter directly.
- **Ad spend:** nothing creates or enables a campaign except the `create_ad_campaign` step after an approval that satisfies its `spend` class; the platform budget (daily × days, with end date) is ≤ the approved `maxSpendCents`; the 95% pause is a second guard.
- **Provider text** (Google, Meta, Postmark, NOAA) is never shown; store status codes and our own plain messages. Google/Meta policy-rejection reasons map to a short plain list (`policy`, `payment`, `access`, `targeting`, `other`).
- **Lockfile:** only Task 1 edits `package-lock.json`. **Migrations:** only Task 1 (`0017` generated, `0018` custom, Ruling AP) — E1 uses 0015/0016. The Python service never runs migrations.
- **Python:** `ruff` + `pytest` in CI only (a new `hail` job in `.github/workflows/ci.yml`, GDAL image); nothing Python runs on the build box.

## Review Focus


1. **No money moves without the owner.** Ad steps are `spend`; the handler re-checks the step's approval and the account's `active` status; a retried create first searches by the name tag `Roofline storm <companyStormId> <platform>`; budget × days ≤ the approved max; the 95% pause fires and is retried. (Tasks 6, 19)
2. **Consent and law.** Storm texts are marketing (attested/written only, STOP text, dedupe per storm, weekly cap, FL/OK/MD); emails carry the postal address and a working one-click unsubscribe, honour `email_opt_outs` before every send; landing-page consent is opt-in and recorded with evidence. (Tasks 6, 12, 13, 20)
3. **One company's storm data stays theirs.** Global hail and footprints are shared; hits, routes, campaigns, pages and requests are tenant tables; the landing page and unsubscribe resolve exactly one company. (Tasks 1, 9, 20)
4. **No double-texting.** Re-drafting replaces a draft, never a running or approved plan; dedupe `storm:<companyStormId>`; YES replies attach to the newest storm text only once. (Tasks 10, 11, 21)
5. **Hail correctness.** Contour levels, mm→in, convective-day boundaries, storm ids stable across runs, provisional → final, "data is behind" banner. (Tasks 2, 3, 8)
