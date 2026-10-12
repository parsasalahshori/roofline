
# Task 17s report: agent rule values, API and Settings → Agents form

Built: p1-api-shared (shared AgentValues/AgentValuesPatch schemas, GET/PATCH /api/agent-values under company_admin, audit row with field names only, API test); p2-web-form (AgentRules form, CSS module, copy, settings api/key, one import + mount in AgentsTab); p3-web-test (agent-rules web test).
Office is not company_admin in permissions.ts, so the API test asserts 403 for rep and office.

Review 1: 1 finding, fixed. Contact check 1: amended. Review 2: 0 findings.
Lead fixes: a1-settings.test.tsx stub gained GET /api/agent-values (AgentsTab now reads it). CI round 1 (run 38215684590) failed: the server reports array element errors as `claimsNudgeDays.0` / `followupDays.0`; the web already strips the suffix, so the two API bound tests now accept the indexed name. Commit 082d896.

Minors: scratch smoke test was removed before commit.

Verify: web vitest agent-rules, copy-rules, a1-settings 15/15 pass; lint, lint:css, typecheck, build:web clean. CI run 38217073981 on 082d896: PASSED.
