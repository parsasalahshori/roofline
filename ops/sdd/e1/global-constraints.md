## Global Constraints (E1 Estimator and homeowner page)

Adapted from `ops/sdd/c1/global-constraints.md` (which carries F1–F3's rules) and the plan's Global Constraints (`docs/superpowers/plans/2026-10-12-roofline-estimator.md`). Spec: `docs/superpowers/specs/2026-10-12-roofline-estimator-design.md`. Branch `e1-estimator` from `c1-crm` once C1 is merged; task branches `e1-t<N>`. E1 rulings use the prefix **E** (EA, EB, …).

**C1 is not built yet.** Every name marked **[C1]** in a brief comes from the C1 plan and briefs (`ops/sdd/c1/`). Before starting a task, the lead checks each [C1] name against `c1-crm` and records any difference in the task report; a renamed C1 export is followed, not re-created.

**Everything in `ops/sdd/c1/global-constraints.md` applies** (code and repo, time, web, tests), with these E1 changes:
- **Migrations:** E1 owns `0015_estimator_schema.sql` (generated) and `0016_estimator_grants_rls.sql` (custom), both in Task 1. C1 ends at `0014` (Ruling AP).
- **Lockfile:** only Task 1 edits `package-lock.json` (`yauzl`, `stream-json`, `aws4fetch` + types). `pdfkit` is already there from C1 T1 **[C1]**.
- **`@roofline/db/system`** is also used in `apps/api/src/public/**` (token → company, F3 Ruling 4) and `apps/api/src/jobs/scheduler/**` (footprint and exact-report fan-outs).
- **Global footprint tables** (`building_footprints`, `building_footprint_states`) hold no tenant data: `app_tenant` SELECT on `building_footprints` only; writes are `app_system` from the loader job.
- **Step handlers** register in `apps/api/src/tasks/handlers.ts` (`builtInHandlers`; `StepHandler` from `tasks/runner.ts`), not in `jobs/handlers.ts`.
- **Mail:** the F3 `Mailer` sends `{ to, subject, text }` only — no attachments (Ruling EE).

**From the plan (verbatim):**
- **Everything in C1's Global Constraints applies** (TypeScript/ESM, enum columns with `enumCheck`, tenant tables with forced RLS and composite FKs, `app_system` column grants plus `app_system_all`, no raw queries from routes, `{error, field?}` errors with messages as module constants, secrets only from `config.ts`, copy rules, feature hooks in `features/<feature>/api.ts`, no third-party UI library, 12px / AA / 40px / 375px rules, company time zone for dates).
- **`@roofline/db/system`** is allowed in `apps/api/src/public/**` (F3 Ruling 4) — the homeowner API uses it only to resolve a token hash to `{companyId, proposalId}`; and in `apps/api/src/jobs/scheduler/**` for the footprint and EagleView fan-outs.
- **Global footprint tables** (`building_footprints`, `building_footprint_states`) carry no tenant data: `app_tenant` gets SELECT on `building_footprints` only; writes are `app_system` from the loader job.
- **Money:** integer cents everywhere; the pricing engine's output is frozen per option; homeowners never see unit prices (spec Decision 15).
- **"Estimate"** labels every instant number and every price derived from one, in the app, the PDF and the homeowner page (master §9.2).
- **Provider text** (EagleView, R2, Microsoft download errors) is never stored or shown; keep status codes and our own plain messages.
- **Lockfile:** only Task 1 edits `package-lock.json`. **Migrations:** only Task 1 (0015 generated, 0016 custom) — C1 used 0013/0014 (Ruling AP).
- **Public page:** no session, no third-party scripts, `noindex`, `Referrer-Policy: no-referrer`, rate limits per IP and per token, and the token is never logged (log `token_hash` prefix only).

## Review Focus


1. **A link opens exactly one company's proposal.** No token guessing (32 random bytes), constant-time comparison through the hash index, no other customer data on the page, another company's data never reachable. (Tasks 11, 12)
2. **What was signed can be proven.** The `document_sha256` covers the option as shown; the PDF hash is stored; nothing edits a signed proposal; a resend never changes the link of a signed proposal. (Tasks 4, 12, 13)
3. **Money approved once.** The EagleView order is claimed before the call, an uncertain result is never retried, the usage event is recorded once per report, and the max spend shown in R2 bounds the order. (Tasks 9, 10)
4. **Prices that don't drift.** A sent proposal never re-prices; an exact report on a sent proposal creates a revised draft. (Tasks 8, 10)
5. **Geometry edge cases.** Outlines across the antimeridian don't occur in the US, but self-intersecting edits, 3-corner outlines, very large outlines (warehouses) and points with no footprint must all give plain results, not 500s. (Tasks 2, 7)
