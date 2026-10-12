# D1 latency and cost report

Status: **not run yet.** The tables below are empty on purpose. Nothing in CI or in the build can fill them, because the numbers
come from the real Claude models and cost money. The owner runs the scripted evals by hand once (after the model smoke, M0 in
`docs/superpowers/d1-manual-smoke.md`), reads the result files, and copies the numbers in here. Never commit the result files
themselves.

This report answers acceptance criterion 34 (`docs/superpowers/d1-acceptance.md`: "The eval report lists p50 and p95") and feeds
the owner's decision on Opus fast mode (spec section 18, Decision 6).

## Targets (spec section 7, "Latency target and measurement")

| What | Target |
| --- | --- |
| Time from the caller's last word to the first spoken text token, Opus turns | p50 <= 900 ms, p95 <= 1800 ms |
| Everything else | Reported, no target. Speech recognition and speech synthesis add their own time on both ends and are not in these numbers. |
| Cost of one full eval run (every scenario once, spec section 16) | About $3 (the calls themselves are a few cents each; the caller-simulator and tone grader are the rest) |

If the Opus first-token p95 misses 1800 ms, the owner decides whether to turn on Opus fast mode (`FRONT_DESK_OPUS_FAST`, twice the
Opus price) or to accept the measured latency.

## How to run it

You need the API settings loaded from your `.env` (the same ones the API reads) and a Claude API key with a spend limit you are
comfortable with.

```
set -a; . ./.env; set +a
npm run eval:front-desk -w @roofline/api -- --confirm-spend                       # every scenario, one run each (about $3)
npm run eval:front-desk -w @roofline/api -- --confirm-spend --runs 3              # three runs each, for stable p95 numbers (about $9)
npm run eval:front-desk -w @roofline/api -- --confirm-spend --scenario booking,price
npm run eval:front-desk -w @roofline/api -- --confirm-spend --out /tmp/d1-eval.json
```

- It refuses without `--confirm-spend` and without `ANTHROPIC_API_KEY`, before it sends anything. No workflow in
  `.github/workflows` runs it, and a test (`apps/api/test/smoke-front-desk-guards.test.ts`) keeps it that way.
- `--runs` is 1 to 10. A p95 over a handful of turns is noisy; use `--runs 3` or more for the numbers you copy here.
- It prints one line per run (`ok` or `FAILED`, with the cost) and writes two files: `<name>.json` (every turn, transcript and
  cost) and `<name>.md` (the summary and latency tables). The default is the system temp folder
  (`roofline-eval-front-desk-<time>.json`). The files hold synthetic callers only, but treat them as scratch and do not commit them.
- The exit code is 1 when any run fails its must/mustNot rules or its tone grade, or could not finish.

### What it plays

Thirteen scenarios, one for each item in the spec section 16 list: booking, booking with a taken slot, job question (verified and
unverified), claim intake, "what's my price?", "will insurance cover it?", angry caller, active leak, spam pitch, recording
objection, prompt injection, rambling caller. They are plain data in `apps/api/test/front-desk/scenarios/`.

For each run a Haiku 5.5 **caller simulator** plays the caller's script turn by turn against the real adapter (Haiku 5.5 router,
Opus 5.5 answers, the real system prompt, tool schemas and guards). Tools are answered from the scenario's seed because this run has
no database. The booking, claim and message writes, the scope checks and the texts are proved by CI against the database with a
ScriptedLlm (`apps/api/test/front-desk/scenarios.test.ts`, `call-paths.test.ts`); the eval proves what the real models say and how fast.

Each run is graded two ways:

1. **By code** (the same `grade()` function CI runs): the tools that must have been called and have succeeded, the outcome, how the
   call ended, the guard hits (none expected: a hit means the model tried to say something the guards had to replace), phrases the
   caller must hear and must not hear, tools that must not run.
2. **By a Haiku 5.5 tone grader**: 1 to 5 per criterion against a fixed rubric (the shared rubric plus the scenario's own). A run
   passes tone with a mean of at least 4 and no criterion under 3.

## What each column means

All times are milliseconds. A "turn" is one caller line and the assistant's reply. The numbers are percentiles over the turns of
the runs in the row (linear interpolation, the same as `percentile_cont` in the M13 query).

| Column | Meaning |
| --- | --- |
| Scenario | The scenario id, or `all` for every scenario together. |
| Route | What the router chose for the turn: `opus` (Opus answers), `fast` (Haiku's own short reply), `transfer`, `end`. |
| Turns | How many turns are in the row. |
| Router p50, p95 | From the caller's line to the router's answer. The Opus request starts at the same moment (speculative start), so this time is not added to Opus turns. |
| First token p50, p95 | From the start of the Opus request to its first text token. This is the number the spec targets. `n/a` for routes that never ask Opus. |
| Total p50, p95 | From the caller's line to the end of the assistant's turn, including tool rounds. |
| Cost per run (call, lower bound) | The router and answer requests of one run, from the usage the API reports (input, cached input and output tokens at the model's price in `PRICES` in `apps/api/src/scripts/eval-front-desk.ts`). |
| Cost per run (harness, lower bound) | The caller simulator and tone grader of one run. This is eval overhead, not call cost. |

Every cost here is a lower bound: cache writes are not counted (the adapter keeps only cache reads), and neither is an
Opus answer started speculatively and then aborted (its usage is never reported), so the invoice is somewhat higher. If a price changes,
update `PRICES` and the date in its comment.

## Results

Not run yet: fill in after the owner's first run. Copy the numbers only (no transcripts).

Run details:

| Date | Who | Models | Runs per scenario | Code version (commit) | Total cost (lower bound) |
| --- | --- | --- | --- | --- | --- |
| not run yet |  |  |  |  |  |

### Latency by scenario and route

| Scenario | Route | Turns | Router p50 | Router p95 | First token p50 | First token p95 | Total p50 | Total p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| not run yet |  |  |  |  |  |  |  |  |
| all | opus |  |  |  |  |  |  |  |
| all | fast |  |  |  |  |  |  |  |
| all | transfer |  |  |  |  |  |  |  |
| all | end |  |  |  |  |  |  |  |

### Pass rates and cost per scenario

| Scenario | Runs | Code-graded passes | Tone mean | Cost per run (call, lower bound) | Cost per run (harness, lower bound) |
| --- | --- | --- | --- | --- | --- |
| not run yet |  |  |  |  |  |

### Against the target

| Check | Result |
| --- | --- |
| Opus first token p50 <= 900 ms | not run yet |
| Opus first token p95 <= 1800 ms | not run yet |
| Decision on Opus fast mode | not decided |

## Real calls

The eval is one source of latency numbers. The other is the stored per-turn timings of real calls (`conversation_turns.router_ms`,
`first_token_ms`, `total_ms`), read with the percentile query in M13 of the manual smoke runbook. Record those here too once there
are real calls, with the date and the number of calls, so the two can be compared.

| Date | Calls | Opus first token p50 | Opus first token p95 | Notes |
| --- | --- | --- | --- | --- |
| not run yet |  |  |  |  |
