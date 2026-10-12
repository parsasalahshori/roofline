### Task 1: Dependencies, E1 schema and the module skeleton

**Base:** `e1-estimator`, branched from `c1-crm` once C1 is merged. **[C1]** C1 owns migrations `0013`/`0014` and added `pdfkit` (C1 T1); E1 takes `0015`/`0016` (Ruling AP). Existing (F1–F3, real): `properties.footprint_id text` and `properties.year_built` already exist (no FK; footprints are global — Ruling EA), `company_settings.financing_apr_bps`/`financing_term_months` exist, `TENANT_TABLES`, `enumCheck`, `0011` grant-section style; `packages/shared/src/setup.ts` `SETUP_ITEM_KEYS` has `prices_and_tiers`.

Read first: `ops/sdd/e1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-estimator-design.md`. Names marked **[C1]** come from the C1 plan/briefs (`ops/sdd/c1/`), not from built code: check each against `c1-crm` before starting and report any difference.

**Split:** Builder 1 schema TS + `0015`; Builder 2 `0016` grants/RLS + `rls.test.ts`/`migrations.test.ts`; Builder 3 npm dependencies, placeholders, barrels, shared enum constants.

**Files:**
- Modify: `packages/db/src/schema/{global,tenant,enums}.ts`, `packages/db/src/{index,system/index}.ts`, `packages/shared/src/index.ts`, `apps/api/package.json`, `package-lock.json`
- Create: `packages/db/migrations/0015_estimator_schema.sql` (generated), `0016_estimator_grants_rls.sql` (custom), meta; placeholders (`export {};`): `packages/db/src/repos/{measurements,tier-templates,proposals,proposal-public,exact-reports,stored-files}.ts`, `packages/db/src/system/{footprints,proposal-links,exact-report-fanout}.ts`, `packages/shared/src/{roof,tiers,proposals}.ts`
- Test: `packages/db/test/{migrations,rls}.test.ts` (extend)

**Interfaces:**
- **npm (`apps/api`):** `yauzl`, `stream-json`, `aws4fetch` (+ `@types/yauzl`, `@types/stream-json` dev).
- **Shared constants** (in `packages/shared/src/proposals.ts`, written now; Task 4 adds the rest below): `MEASUREMENT_KINDS = ['estimate','exact'] as const`, `MEASUREMENT_METHODS = ['outline','aerial','eagleview','manual'] as const`, `TIERS = ['good','better','best'] as const`, `ADD_ON_UNITS = ['per_square','per_edge_ft','per_ridge_ft','per_valley_ft','per_job'] as const`, `PROPOSAL_STATUSES = ['draft','ready','sent','viewed','signed','declined','expired','replaced'] as const`, `PROPOSAL_EVENT_KINDS = ['sent','viewed','option_viewed','signed','declined','link_resent','link_copied'] as const`, `EXACT_ORDER_STATUSES = ['priced','ordering','waiting','complete','attention','canceled'] as const`, `FOOTPRINT_STATE_STATUSES = ['loading','ready','failed'] as const`, `STORED_FILE_KINDS = ['signed_proposal_pdf'] as const`, and types.
- **Global tables:** `building_footprints` (`id bigserial pk`, `state char(2) not null`, `geom geometry(Polygon,4326) not null` GIST, `area_sq_ft numeric(12,1) not null`, `source text not null`, `source_ref text`; index `(state)`), `building_footprint_states` (`state char(2) pk`, `status` CHECK, `buildings integer`, `source_url text`, `started_at`, `loaded_at`, `error_plain`).
- **Tenant tables** (company_id, timestamps, `unique (company_id, id)`, composite FKs, in `TENANT_TABLES`) — columns exactly as spec §3.4, §4.1, §4.3, §5.3, §8: `measurements`, `tier_templates` (unique `(company_id, tier)`), `proposals` (unique `(company_id, number)`, unique `link_token_hash`), `proposal_counters` (`company_id` unique, `next_number`), `proposal_options` (unique `(proposal_id, tier)`), `proposal_signatures` (unique `proposal_id`), `proposal_events` (index `(proposal_id, at)`), `exact_report_orders` (unique `(company_id, reference_id)`), `stored_files`.
- **`company_settings` gains** `default_pitch_x12 numeric(4,2) not null default 6` (CHECK 0–24), `overhang_ft numeric(3,1) not null default 1` (0–3), `proposal_valid_days integer not null default 30` (1–180), `aerial_measure boolean not null default false`, `estimate_change_clause boolean not null default true`.
- **`0016`:** tenant grants (SELECT/INSERT/UPDATE on the nine tables; no DELETE except none), RLS blocks; `GRANT SELECT ON building_footprints TO app_tenant`; `GRANT ALL ON building_footprints, building_footprint_states TO app_system`; column-level `GRANT SELECT (id, company_id, link_token_hash, status, valid_until) ON proposals TO app_system` + `app_system_all` on `proposals`; `GRANT SELECT (id, company_id, status, last_polled_at) ON exact_report_orders TO app_system` + `app_system_all`; tenant UPDATE grants on the new `company_settings` columns.

**Tests:**
- the nine tables are tenant tables with RLS forced; `proposals.link_token_hash` unique across companies (23505); `tier_templates` one per tier per company; `building_footprints` readable by `app_tenant` with any `app.company_id`, not writable; the extended grant lists.

**Carries and rulings:**
- **Ruling EA:** `properties.footprint_id` stays `text` (the stringified `building_footprints.id`), with no FK — footprints are a global table and may be reloaded.
- Barrels get every E1 line here.

**Verify notes:**
- db suite on CI (`ops/bin/ci-check`); typecheck, lint locally.
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(db): E1 schema (footprints, measurements, tiers, proposals, signatures, exact reports) and skeleton`
