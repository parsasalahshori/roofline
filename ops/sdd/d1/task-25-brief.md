### Task 25: Scripted call evals and latency report

**Base:** `d1-front-desk` after Tasks 5 and 19 are merged. From T5: the real adapter; From T4: `ScriptedLlm`. Pattern: F3 T37 `assertConfirmed`.

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

**Split:** Builder 1 scenarios `apps/api/test/front-desk/scenarios/*.ts` (spec §16 list: caller lines, seeded data, `must` (tools called, outcome, guard hits = 0 or expected), `mustNot` (phrases, tools), tone rubric) + the CI runner over `ScriptedLlm` scripts derived from each scenario (proves plumbing and rubric code); Builder 2 `scripts/eval-front-desk.ts` (`npm run eval:front-desk -- --confirm-spend [--scenario x] [--runs 3]`: real `Llm`, a Haiku 5.5 caller-simulator that plays the caller's script turn by turn, code-graded must/mustNot, a Haiku 5.5 tone grader with a fixed rubric, refuses without `ANTHROPIC_API_KEY` and `--confirm-spend`); Builder 3 latency report (p50/p95 router, first token, total per scenario and route; cost per run from usage) written to `docs/superpowers/d1-latency.md` by hand after a run + `smoke-guards` test that the script refuses without the flag.

**Files:** Create the listed files; Modify `apps/api/package.json` (`eval:front-desk`).

**Carries and rulings:**
- **LLM rules (Ruling DA):** the only Claude client is `@anthropic-ai/sdk` (`new Anthropic({ apiKey, fetch?, maxRetries })`) inside `apps/api/src/providers/anthropic/`; model ids exactly `claude-haiku-5-5` (router, summaries) and `claude-opus-5-5` (answers), from config defaults. Tests use `ScriptedLlm`; the adapter's own test injects a scripted fake `fetch` serving recorded fixtures. **No test or CI step ever reaches api.anthropic.com**: `testConfig()` leaves `ANTHROPIC_API_KEY` unset so `anthropicFor()` returns null, and CI sets no key.
- `eval:front-desk` refuses without `--confirm-spend` and a key; CI runs the scenarios with `ScriptedLlm` only (plan Ruling 9).

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `test(front-desk): scripted call evals with real models by hand, and a latency report`
