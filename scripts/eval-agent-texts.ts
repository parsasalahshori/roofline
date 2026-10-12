// Agent-text eval, by hand only (G1 Task 18a, spec section 9). Calls paid models:
//   npm run eval:agent-texts -- --confirm-spend [--only lead-01,claims-03]
// Drafts each fixture case through the Llm seam's Anthropic adapter (Ruling DA), runs the code
// checks, grades each text with Haiku, and writes scripts/eval-results/agent-texts-<time>.md.
// Exit 1 when it refuses to run or when any code check fails. Never run in CI or tests.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../apps/api/src/config.ts';
import { anthropicFor } from '../apps/api/src/providers/anthropic/index.ts';
import { gradeText } from './eval-agent-texts/grade.ts';
import {
  ArgError,
  DEFAULT_DRAFT_MODEL,
  GRADE_MODEL,
  checkText,
  describeEstimate,
  estimateCost,
  parseArgs,
  parseFixtures,
  preflight,
  renderReport,
  reportFileName,
  summaryLine,
  type CaseResult,
  type EvalArgs,
  type EvalCase,
} from './eval-agent-texts/lib.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<number> {
  let args: EvalArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof ArgError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
  let cases: EvalCase[] = parseFixtures(JSON.parse(readFileSync(path.join(here, 'eval-fixtures/agent-texts.json'), 'utf8')));
  if (args.only) {
    const unknown = args.only.filter((id) => !cases.some((c) => c.id === id));
    if (unknown.length > 0) {
      console.error(`No such case: ${unknown.join(', ')}.`);
      return 1;
    }
    cases = cases.filter((c) => args.only!.includes(c.id));
  }
  const draftModel = process.env.AGENT_DRAFT_MODEL?.trim() || DEFAULT_DRAFT_MODEL;
  let estimate;
  try {
    estimate = estimateCost(cases.length, draftModel, GRADE_MODEL);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  console.log(describeEstimate(estimate, draftModel, GRADE_MODEL));
  const ready = preflight(args, process.env);
  if (!ready.ok) {
    console.error(ready.message);
    return 1;
  }

  // anthropicFor reads only the key and the four model names (providers/anthropic/client.ts).
  const config = {
    ANTHROPIC_API_KEY: ready.apiKey,
    AGENT_DRAFT_MODEL: draftModel,
    AGENT_EXTRACT_MODEL: GRADE_MODEL,
    FRONT_DESK_ROUTER_MODEL: GRADE_MODEL,
    FRONT_DESK_ANSWER_MODEL: DEFAULT_DRAFT_MODEL,
  } as Partial<Config> as Config;
  const llm = anthropicFor(config);
  if (!llm) {
    console.error('Refusing to run: ANTHROPIC_API_KEY is not set.');
    return 1;
  }
  const grader = new Anthropic({ apiKey: ready.apiKey, maxRetries: 2 });

  const startedAt = new Date();
  const results: CaseResult[] = [];
  for (const [i, c] of cases.entries()) {
    process.stdout.write(`[${i + 1}/${cases.length}] ${c.id} ... `);
    const r: CaseResult = {
      id: c.id,
      kind: c.kind,
      text: null,
      draftRefused: false,
      draftError: null,
      checks: checkText(null, c.expectedFacts),
      grade: null,
      draftUsage: null,
      gradeUsage: null,
    };
    try {
      const drafted = await llm.draftTexts({ instruction: c.kind, facts: [c.facts] });
      r.draftUsage = drafted.usage;
      r.draftRefused = drafted.refused;
      r.text = drafted.texts.find((t) => t.jobId === c.facts.jobId)?.body ?? null;
    } catch (err) {
      // The adapter turns SDK errors into LlmUnavailableError with the status only.
      r.draftError = err instanceof Error ? err.message : 'unknown error';
    }
    r.checks = checkText(r.text, c.expectedFacts);
    if (r.text !== null) {
      const graded = await gradeText(grader, GRADE_MODEL, c.kind, c.facts, r.text);
      r.grade = graded.outcome;
      r.gradeUsage = graded.usage;
    }
    results.push(r);
    console.log(`${r.checks.pass ? 'pass' : 'FAIL'}${r.grade?.status === 'graded' ? `, grade ${r.grade.grade}` : ''}`);
  }
  const report = { startedAt, finishedAt: new Date(), draftModel, gradeModel: GRADE_MODEL, estimate, cases: results };
  const dir = path.join(here, 'eval-results');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, reportFileName(startedAt));
  writeFileSync(file, renderReport(report));
  console.log(summaryLine(report));
  console.log(`Report: ${path.relative(process.cwd(), file)}`);
  return results.every((x) => x.checks.pass) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : 'The eval stopped on an unexpected error.');
    process.exit(1);
  },
);
