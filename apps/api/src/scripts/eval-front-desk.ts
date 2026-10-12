import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Anthropic from '@anthropic-ai/sdk';
import {
  DEFAULT_WORK_HOURS,
  FRONT_DESK_TOOLS,
  type FrontDeskToolName,
  guardSentence,
  type GuardHit,
  SentenceBuffer,
  shouldTransfer,
  type TransferReason,
} from '@roofline/shared';
import { ConfigError, loadConfig, type Config } from '../config.ts';
import { SAY_SPAM_ENDING } from '../front-desk/engine.ts';
import { summarize } from '../front-desk/engine-state.ts';
import { fillerFor } from '../front-desk/fillers.ts';
import { buildCompanyBlock } from '../front-desk/prompt.ts';
import { isRecordingObjection } from '../front-desk/recording.ts';
import { appendAssistant, appendToolResults, appendUser, newConversationState } from '../front-desk/state.ts';
import { anthropicFor, evalModelsFor, type EvalModels } from '../providers/anthropic/index.ts';
import { scoresMatchRubric, type TranscriptLine } from '../providers/anthropic/eval.ts';
import type { Llm, LlmEvent, RouteDecision, TurnUsage } from '../providers/llm.ts';
import { grade, percentile } from '../../test/front-desk/scenarios/grade.ts';
import { SCENARIOS, scenarioById } from '../../test/front-desk/scenarios/index.ts';
import { BASE_TONE_RUBRIC, type Ending, type Observed, type ObservedTurn, type Scenario } from '../../test/front-desk/scenarios/types.ts';
import { createWorld } from '../../test/front-desk/scenarios/world.ts';
import { SmokeRefused, assertConfirmed } from './smoke/guards.ts';

/*
 * Scripted call evals with the real Claude models, by hand only (D1 Task 25). Costs real money (about $3 for one full
 * run of every scenario, spec section 16), so it needs --confirm-spend and ANTHROPIC_API_KEY, and nothing in CI runs it.
 *
 *   npm run eval:front-desk -w @roofline/api -- --confirm-spend [--scenario booking,price] [--runs 3] [--out <file.json>]
 *
 * For each scenario a Haiku 5.5 caller-simulator plays the caller's script turn by turn against the real Llm adapter
 * (Haiku 5.5 router, Opus 5.5 answers, the real system prompt, tool schemas and guards). Tools are answered from the
 * scenario's seed (test/front-desk/scenarios/world.ts) because this run has no database; the database-backed behaviour
 * is proved in CI by scenarios.test.ts with a ScriptedLlm. must / mustNot are code-graded by the same grade() function
 * CI exercises, and a Haiku 5.5 grader scores the tone rubric. It records router, first-token and total latency per
 * scenario and route, and the cost of each run from the usage the API reports.
 *
 * Results go to a .json and a .md file (default: the system temp folder). They are never committed; the numbers that
 * matter are copied by hand into docs/superpowers/d1-latency.md. Provider error text is never printed.
 * Ruling DA: the only Claude client is the one in providers/anthropic/; this file constructs none.
 */

export const USAGE =
  'Usage: npm run eval:front-desk -w @roofline/api -- --confirm-spend [--scenario <id>[,<id>]] [--runs <1-10>] [--out <file.json>]';

const CONFIRM_FLAG = '--confirm-spend' as const;
const GENERIC_FAILURE = 'The Claude service turned this down or could not be reached.';
const TONE_MISMATCH = 'The tone grader did not score exactly the rubric, so this run has no tone grade.';
const MAX_RUNS = 10;
const MAX_TOOL_ROUNDS = 4;
const TURN_TIMEOUT_MS = 60_000;
/** A run's tone passes when the mean is at least this and no criterion scores below TONE_FLOOR. */
export const TONE_PASS_MEAN = 4;
export const TONE_FLOOR = 3;

export type EvalIo = { log(line: string): void; error(line: string): void };
const consoleIo: EvalIo = { log: (line) => console.log(line), error: (line) => console.error(line) };

export type Args = { argv: string[]; scenarios: string[] | null; runs: number; out: string | null };

/** The arguments, or null when they are not valid. */
export function parseArgs(argv: readonly string[]): Args | null {
  const seen: string[] = [];
  let scenarios: string[] | null = null;
  let runs = 1;
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--scenario' || arg === '--runs' || arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return null;
      i++;
      if (arg === '--scenario') {
        if (scenarios !== null) return null;
        scenarios = value.split(',').map((s) => s.trim()).filter((s) => s !== '');
        if (scenarios.length === 0) return null;
      } else if (arg === '--runs') {
        if (!/^\d+$/.test(value)) return null;
        runs = Number(value);
        if (runs < 1 || runs > MAX_RUNS) return null;
      } else {
        if (out !== null) return null;
        out = value;
      }
      continue;
    }
    if (arg !== CONFIRM_FLAG || seen.includes(arg)) return null;
    seen.push(arg);
  }
  return { argv: seen, scenarios, runs, out };
}

/* ---------------------------------------------------------------- cost */

/** US dollars per million tokens (the claude-api model table, cached 2026-10-06). Update when prices change. */
export const PRICES: Readonly<Record<string, { input: number; cacheRead: number; output: number }>> = {
  'claude-haiku-5-5': { input: 0.1, cacheRead: 0.01, output: 0.5 },
  'claude-opus-5-5': { input: 4, cacheRead: 0.2, output: 20 },
};

/** Cost of one request from its usage. Cache writes are not in the usage this adapter keeps, so they are not counted. An unknown model is priced as Opus, the dearer one. */
export function costUsd(u: Pick<TurnUsage, 'model' | 'inputTokens' | 'cachedTokens' | 'outputTokens'>): number {
  const p = PRICES[u.model] ?? PRICES['claude-opus-5-5']!;
  return (u.inputTokens * p.input + u.cachedTokens * p.cacheRead + u.outputTokens * p.output) / 1_000_000;
}

/* ---------------------------------------------------------------- one call */

const COMPANY_BLOCK = buildCompanyBlock({
  name: 'Eval Roofing',
  timezone: 'America/Chicago',
  city: 'Omaha',
  state: 'NE',
  workHours: DEFAULT_WORK_HOURS,
  facts: 'Roof inspections, repairs and replacements. Free inspections. Closed on holidays.',
  services: ['Roof inspections', 'Storm and hail damage inspections', 'Repairs', 'Roof replacement'],
  towns: ['Omaha'],
  repName: null,
  canMove: true,
  canCancel: true,
});

const TOOL_NAMES = (Object.keys(FRONT_DESK_TOOLS) as FrontDeskToolName[]).sort();
const SPAM_INTENTS = new Set(['spam', 'sales_pitch']);
const ASK_PERSON_INTENTS = new Set(['ask_for_person', 'transfer', 'human']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type UsageRole = 'router' | 'answer' | 'simulator' | 'grader';
export type UsageRecord = { role: UsageRole; usage: TurnUsage };

export type PlayedCall = { observed: Observed; usages: UsageRecord[]; transcript: TranscriptLine[] };

function idsIn(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => idsIn(v, out));
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as object)) {
      if (typeof v === 'string') {
        if (k.endsWith('Id') && k !== 'slotUserId' && UUID.test(v)) out.push(v);
      } else idsIn(v, out);
    }
  }
  return out;
}

type Streamed =
  | { ok: true; stopReason: 'end_turn' | 'tool_use' | 'refusal' | 'max_tokens'; usage: TurnUsage; content: Anthropic.ContentBlock[]; toolUses: { id: string; name: FrontDeskToolName; input: unknown }[] }
  | { ok: false };

/**
 * Plays one scenario against the real Llm: the simulator speaks, the router and a speculative answer start together,
 * the route decides what happens (the same rules as front-desk/engine.ts), sentences go through the guards, tools are
 * answered by the scenario's world. Throws only for a failure of the simulator; a failing Llm ends the call as a
 * model_failure transfer, as the engine would.
 */
export async function playCall(sc: Scenario, llm: Llm, models: EvalModels): Promise<PlayedCall> {
  const world = createWorld(sc.seed);
  const state = newConversationState({
    companyId: 'eval',
    conversationId: 'eval',
    channel: 'voice',
    phone: '+14025550177',
    callId: null,
    companyBlock: COMPANY_BLOCK,
    repName: null,
    startedAt: new Date(),
  });
  const usages: UsageRecord[] = [];
  const transcript: TranscriptLine[] = [];
  const turns: ObservedTurn[] = [];
  let ending: Ending = { kind: 'open' };
  let recordingStopped = false;

  for (let n = 0; n < sc.callerLines.length + 3 && ending.kind === 'open'; n++) {
    const sim = await models.simulateCaller({ persona: sc.persona, script: sc.callerLines, transcript, spoken: n });
    usages.push({ role: 'simulator', usage: sim.usage });
    if (sim.done || sim.text === '') break;
    transcript.push({ speaker: 'caller', text: sim.text });
    if (sc.seed.recording && isRecordingObjection(sim.text)) recordingStopped = true;

    const turn = await playTurn(sim.text);
    turns.push(turn.observed);
    if (turn.ending) ending = turn.ending;
    transcript.push({ speaker: 'assistant', text: turn.observed.spoken });
  }
  return { observed: { turns, ending, recordingStopped }, usages, transcript };

  async function playTurn(callerText: string): Promise<{ observed: ObservedTurn; ending: Ending | null }> {
    const started = performance.now();
    appendUser(state, callerText);
    const said: string[] = [];
    const hits = new Set<GuardHit>();
    const tools: ObservedTurn['tools'] = [];
    let route = 'opus';
    let routerMs: number | null = null;
    let firstTokenMs: number | null = null;
    let turnEnding: Ending | null = null;

    const speak = (text: string): void => {
      const g = guardSentence(text, { repName: null });
      g.hits.forEach((h) => hits.add(h));
      said.push(g.text);
    };

    const controllers: AbortController[] = [];
    const chain = (): AbortController => {
      const c = new AbortController();
      controllers.push(c);
      setTimeout(() => c.abort(), TURN_TIMEOUT_MS).unref();
      return c;
    };
    const openStream = (): { iter: AsyncIterator<LlmEvent>; first: Promise<IteratorResult<LlmEvent>>; ac: AbortController } => {
      const ac = chain();
      try {
        const iter = llm.answer({ companyId: 'eval', companyBlock: state.companyBlock, history: [...state.history], tools: TOOL_NAMES, signal: ac.signal })[Symbol.asyncIterator]();
        const first = iter.next();
        first.catch(() => undefined);
        return { iter, first, ac };
      } catch (err) {
        const first = Promise.reject(err);
        first.catch(() => undefined);
        return { iter: { next: () => Promise.reject(err) }, first, ac };
      }
    };
    async function consume(s: ReturnType<typeof openStream>): Promise<Streamed> {
      const buf = new SentenceBuffer();
      const toolUses: { id: string; name: FrontDeskToolName; input: unknown }[] = [];
      let pending: Promise<IteratorResult<LlmEvent>> | null = s.first;
      try {
        for (;;) {
          const r: IteratorResult<LlmEvent> = await (pending ?? s.iter.next());
          pending = null;
          if (r.done) return { ok: false };
          const ev = r.value;
          if (ev.type === 'text') buf.push(ev.text).forEach(speak);
          else if (ev.type === 'tool_use') toolUses.push({ id: ev.id, name: ev.name, input: ev.input });
          else {
            buf.flush().forEach(speak);
            return { ok: true, stopReason: ev.stopReason, usage: ev.usage, content: ev.assistantContent, toolUses };
          }
        }
      } catch {
        return { ok: false };
      }
    }

    const routeAc = chain();
    const routeP = llm.route({ companyBlock: state.companyBlock, state: summarize(state), callerText, channel: 'voice' }, routeAc.signal);
    routeP.catch(() => undefined);
    const speculative = openStream();

    let decision: (RouteDecision & { usage: TurnUsage }) | null = null;
    try {
      decision = await routeP;
      routerMs = Math.round(performance.now() - started);
      usages.push({ role: 'router', usage: decision.usage });
    } catch {
      // The engine goes on without a route; so does this.
    }
    const dropSpeculative = () => {
      speculative.ac.abort();
      void Promise.resolve(speculative.iter.return?.(undefined)).catch(() => undefined);
    };

    const finish = (): { observed: ObservedTurn; ending: Ending | null } => {
      controllers.forEach((c) => c.abort());
      return {
        observed: {
          caller: callerText,
          spoken: said.join(' ').replace(/\s+/g, ' ').trim(),
          route,
          guardHits: [...hits].sort(),
          tools,
          routerMs,
          firstTokenMs,
          totalMs: Math.round(performance.now() - started),
        },
        ending: turnEnding,
      };
    };

    if (decision) {
      if (ASK_PERSON_INTENTS.has(decision.intent)) state.askedForPersonCount += 1;
      if (decision.intent === 'not_understood') state.failedUnderstanding += 1;
      else state.failedUnderstanding = 0;
    }

    if (decision && SPAM_INTENTS.has(decision.intent)) {
      dropSpeculative();
      route = 'end';
      if (state.channel === 'voice') speak(SAY_SPAM_ENDING);
      turnEnding = { kind: 'end', reason: 'spam' };
      return finish();
    }
    if (decision && decision.route === 'fast' && decision.fastReply) {
      dropSpeculative();
      route = 'fast';
      speak(decision.fastReply);
      appendAssistant(state, [{ type: 'text', text: said.join(' ') }] as unknown as Anthropic.ContentBlock[]);
      return finish();
    }
    if (decision && decision.route === 'end') {
      dropSpeculative();
      route = 'end';
      speak(decision.fastReply ?? 'Thank you for calling. Goodbye.');
      turnEnding = { kind: 'end', reason: 'goodbye' };
      return finish();
    }
    if (decision && decision.route === 'transfer') {
      dropSpeculative();
      route = 'transfer';
      const reason =
        shouldTransfer({
          intent: decision.intent,
          urgent: decision.urgent,
          mood: decision.mood,
          askedForPersonCount: state.askedForPersonCount,
          taskInProgress: state.taskInProgress,
          failedUnderstanding: state.failedUnderstanding,
        }) ?? 'asked';
      turnEnding = { kind: 'transfer', reason };
      return finish();
    }

    // The Opus route (or the router was unavailable).
    let stream = speculative;
    let rounds = 0;
    let failures = 0;
    for (;;) {
      const out = await consume(stream);
      if (!out.ok) {
        failures += 1;
        if (failures >= 2) {
          speak("Sorry, I'm having trouble on my end. Let me get someone for you.");
          turnEnding = { kind: 'transfer', reason: 'model_failure' satisfies TransferReason };
          return finish();
        }
        stream = openStream();
        continue;
      }
      failures = 0;
      usages.push({ role: 'answer', usage: out.usage });
      firstTokenMs ??= out.usage.firstTokenMs;
      if (out.stopReason === 'refusal' || out.stopReason === 'max_tokens') {
        speak('Let me get someone who can help with that.');
        turnEnding = { kind: 'transfer', reason: 'model_failure' };
        return finish();
      }
      appendAssistant(state, out.content);
      if (out.stopReason !== 'tool_use' || out.toolUses.length === 0) return finish();

      rounds += 1;
      if (rounds > MAX_TOOL_ROUNDS) {
        turnEnding = { kind: 'transfer', reason: 'not_understood' };
        return finish();
      }
      const results: { toolUseId: string; content: string; isError: boolean }[] = [];
      for (const use of out.toolUses) {
        const filler = fillerFor(use.name);
        if (filler !== null) speak(filler);
        const parsed = FRONT_DESK_TOOLS[use.name].input.safeParse(use.input);
        let reply: { ok: boolean; forModel: string; shownIds?: string[] };
        if (!parsed.success) reply = { ok: false, forModel: 'Those details were not valid. Check them and try once more.' };
        else if (idsIn(parsed.data).some((id) => !state.shownIds.has(id))) reply = { ok: false, forModel: "That isn't one of this caller's records." };
        else {
          reply = world.run(use.name, parsed.data);
          reply.shownIds?.forEach((id) => state.shownIds.add(id));
          if (use.name === 'transfer_to_person') {
            turnEnding = { kind: 'transfer', reason: (parsed.data as { reason: string }).reason };
          } else if (use.name === 'end_call') {
            turnEnding = { kind: 'end', reason: (parsed.data as { reason: string }).reason };
          }
        }
        tools.push({ name: use.name, ok: reply.ok, result: reply.forModel });
        results.push({ toolUseId: use.id, content: reply.forModel, isError: !reply.ok });
      }
      appendToolResults(state, results);
      if (turnEnding) return finish();
      stream = openStream();
    }
  }
}

/* ---------------------------------------------------------------- results */

export type ToneResult = { scores: { criterion: string; score: number; note: string }[]; mean: number; pass: boolean };
export type RunResult = {
  scenario: string;
  run: number;
  pass: boolean;
  failures: string[];
  tone: ToneResult | null;
  /** Set when the run could not finish (a plain sentence, never provider text). */
  error: string | null;
  turns: ObservedTurn[];
  ending: Ending;
  transcript: TranscriptLine[];
  /** The call itself (router and answers) and the harness (simulator and grader), in US dollars. */
  cost: { call: number; harness: number };
};

export function toneResult(scores: ToneResult['scores']): ToneResult {
  const mean = scores.length === 0 ? 0 : scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
  return { scores, mean, pass: scores.length > 0 && mean >= TONE_PASS_MEAN && scores.every((s) => s.score >= TONE_FLOOR) };
}

export type Stat = { p50: number | null; p95: number | null };
export type LatencyRow = { scenario: string; route: string; turns: number; router: Stat; firstToken: Stat; total: Stat };

const stat = (values: (number | null)[]): Stat => {
  const v = values.filter((x): x is number => x !== null);
  const round = (x: number | null) => (x === null ? null : Math.round(x));
  return { p50: round(percentile(v, 0.5)), p95: round(percentile(v, 0.95)) };
};

/** p50 and p95 of the router, first token and total per scenario and route, then the same over every scenario ('all'). */
export function latencyRows(results: readonly RunResult[]): LatencyRow[] {
  const rows: LatencyRow[] = [];
  const build = (scenario: string, route: string, turns: ObservedTurn[]) => {
    if (turns.length === 0) return;
    rows.push({
      scenario,
      route,
      turns: turns.length,
      router: stat(turns.map((t) => t.routerMs)),
      firstToken: stat(turns.map((t) => t.firstTokenMs)),
      total: stat(turns.map((t) => t.totalMs)),
    });
  };
  const ids = [...new Set(results.map((r) => r.scenario))];
  const routes = ['fast', 'opus', 'transfer', 'end'];
  for (const id of ids) {
    const turns = results.filter((r) => r.scenario === id).flatMap((r) => r.turns);
    for (const route of routes) build(id, route, turns.filter((t) => t.route === route));
  }
  const all = results.flatMap((r) => r.turns);
  for (const route of routes) build('all', route, all.filter((t) => t.route === route));
  return rows;
}

const ms = (x: number | null) => (x === null ? 'n/a' : String(x));
const usd = (x: number) => `$${x.toFixed(3)}`;

export function renderMarkdown(o: { startedAt: string; scenarios: string[]; runs: number; results: readonly RunResult[] }): string {
  const lines: string[] = [];
  lines.push(`# Front Desk scripted call eval`, '', `Started ${o.startedAt}. Runs per scenario: ${o.runs}. Router model claude-haiku-5-5, answers claude-opus-5-5.`, '');
  lines.push('| Scenario | Runs | Passed | Tone mean | Cost per run (call) | Cost per run (harness) |', '| --- | --- | --- | --- | --- | --- |');
  for (const id of o.scenarios) {
    const rs = o.results.filter((r) => r.scenario === id);
    const passed = rs.filter((r) => r.pass).length;
    const tones = rs.flatMap((r) => (r.tone ? [r.tone.mean] : []));
    const toneMean = tones.length === 0 ? 'n/a' : (tones.reduce((a, b) => a + b, 0) / tones.length).toFixed(1);
    const avg = (pick: (r: RunResult) => number) => (rs.length === 0 ? 0 : rs.reduce((a, r) => a + pick(r), 0) / rs.length);
    lines.push(`| ${id} | ${rs.length} | ${passed} | ${toneMean} | ${usd(avg((r) => r.cost.call))} | ${usd(avg((r) => r.cost.harness))} |`);
  }
  const total = o.results.reduce((a, r) => ({ call: a.call + r.cost.call, harness: a.harness + r.cost.harness }), { call: 0, harness: 0 });
  lines.push('', `Total cost of this run: ${usd(total.call + total.harness)} (the calls ${usd(total.call)}, the simulator and grader ${usd(total.harness)}).`, '');

  const failed = o.results.filter((r) => !r.pass);
  lines.push('## Failures', '');
  if (failed.length === 0) lines.push('None.');
  for (const r of failed) {
    lines.push(`- ${r.scenario} run ${r.run}: ${r.error ?? [...r.failures, ...(r.tone && !r.tone.pass ? [`tone mean ${r.tone.mean.toFixed(1)}`] : [])].join('; ')}`);
  }
  lines.push('', '## Latency (milliseconds, caller\'s last word to first token is the first-token column)', '');
  lines.push('Spec target for Opus turns: first token p50 <= 900, p95 <= 1800.', '');
  lines.push('| Scenario | Route | Turns | Router p50 | Router p95 | First token p50 | First token p95 | Total p50 | Total p95 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of latencyRows(o.results)) {
    lines.push(`| ${r.scenario} | ${r.route} | ${r.turns} | ${ms(r.router.p50)} | ${ms(r.router.p95)} | ${ms(r.firstToken.p50)} | ${ms(r.firstToken.p95)} | ${ms(r.total.p50)} | ${ms(r.total.p95)} |`);
  }
  return lines.join('\n') + '\n';
}

/* ---------------------------------------------------------------- main */

export type EvalDeps = { llm: Llm; models: EvalModels };
/** Builds the real Llm and eval models from the settings, or null without a key. Tests pass fakes. */
export type EvalFactory = (config: Config) => EvalDeps | null;

const realFactory: EvalFactory = (config) => {
  const llm = anthropicFor(config);
  const models = evalModelsFor(config);
  return llm && models ? { llm, models } : null;
};

export type EvalFiles = { write(path: string, text: string): void };
const realFiles: EvalFiles = {
  write: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
};

/** Runs the eval and returns the exit code. Refuses before it reads any setting or touches any provider when --confirm-spend is missing, and before it builds any client in CI or with FAKE_PROVIDERS on. */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: EvalIo = consoleIo,
  factory: EvalFactory = realFactory,
  files: EvalFiles = realFiles,
  now: () => Date = () => new Date(),
): Promise<number> {
  const args = parseArgs(argv);
  if (!args) {
    io.error(USAGE);
    return 1;
  }
  try {
    assertConfirmed(args.argv, CONFIRM_FLAG);

    let config: Config;
    try {
      config = loadConfig(env);
    } catch (err) {
      if (err instanceof ConfigError) throw new SmokeRefused('The API settings are not valid. Load your .env first (set -a; . ./.env; set +a).');
      throw err;
    }
    // Belt and braces (Ruling DA): never spend from CI, and never grade fakes as if they were the real models.
    if (env.CI !== undefined && env.CI !== '') throw new SmokeRefused('The eval spends real money, so it never runs in CI. Run it by hand on your own machine.');
    if (config.FAKE_PROVIDERS) throw new SmokeRefused('FAKE_PROVIDERS is on, so there are no real models to grade. Unset it to run the eval.');

    const chosen = args.scenarios ?? SCENARIOS.map((s) => s.id);
    const unknown = chosen.filter((id) => scenarioById(id) === undefined);
    if (unknown.length > 0) throw new SmokeRefused(`Unknown scenario: ${unknown.join(', ')}. Choose from: ${SCENARIOS.map((s) => s.id).join(', ')}.`);

    const deps = factory(config);
    if (deps === null) throw new SmokeRefused('Set ANTHROPIC_API_KEY first.');

    const startedAt = now().toISOString();
    const results: RunResult[] = [];
    for (const id of chosen) {
      const sc = scenarioById(id)!;
      for (let run = 1; run <= args.runs; run++) {
        const result = await runOnce(sc, run, deps);
        results.push(result);
        io.log(`${result.pass ? 'ok     ' : 'FAILED '} ${id} run ${run} (${usd(result.cost.call + result.cost.harness)})${result.error ? `: ${result.error}` : ''}`);
        if (!result.pass && !result.error) {
          for (const f of result.failures) io.log(`         ${f}`);
          if (result.tone && !result.tone.pass) io.log(`         tone mean ${result.tone.mean.toFixed(1)}, lowest ${Math.min(...result.tone.scores.map((x) => x.score))}`);
        }
      }
    }

    const stamp = startedAt.replace(/[:.]/g, '-');
    const jsonPath = args.out ?? join(tmpdir(), `roofline-eval-front-desk-${stamp}.json`);
    const mdPath = jsonPath.replace(/\.json$/, '') + '.md';
    files.write(jsonPath, JSON.stringify({ startedAt, runs: args.runs, scenarios: chosen, results, latency: latencyRows(results) }, null, 2) + '\n');
    files.write(mdPath, renderMarkdown({ startedAt, scenarios: chosen, runs: args.runs, results }));
    io.log(`Results written to ${jsonPath} and ${mdPath}. Do not commit them; copy the numbers into docs/superpowers/d1-latency.md.`);
    const failed = results.filter((r) => !r.pass).length;
    io.log(failed === 0 ? 'All runs passed.' : `${failed} run(s) failed.`);
    return failed === 0 ? 0 : 1;
  } catch (err) {
    io.error(err instanceof SmokeRefused ? err.message : GENERIC_FAILURE);
    return 1;
  }
}

async function runOnce(sc: Scenario, run: number, deps: EvalDeps): Promise<RunResult> {
  const base = { scenario: sc.id, run, turns: [] as ObservedTurn[], ending: { kind: 'open' } as Ending, transcript: [] as TranscriptLine[], cost: { call: 0, harness: 0 } };
  let played: PlayedCall;
  try {
    played = await playCall(sc, deps.llm, deps.models);
  } catch {
    return { ...base, pass: false, failures: [], tone: null, error: GENERIC_FAILURE };
  }
  const usages = [...played.usages];
  const verdict = grade(sc, played.observed);
  let tone: ToneResult | null = null;
  let error: string | null = null;
  try {
    const rubric = [...BASE_TONE_RUBRIC, ...sc.toneRubric];
    const graded = await deps.models.gradeTone({ rubric, transcript: played.transcript });
    usages.push({ role: 'grader', usage: graded.usage });
    // A grade that skips, adds, reorders or relabels a criterion is an error, never a pass.
    if (scoresMatchRubric(rubric, graded.scores)) tone = toneResult(graded.scores);
    else error = TONE_MISMATCH;
  } catch {
    error = GENERIC_FAILURE;
  }
  const cost = { call: 0, harness: 0 };
  for (const u of usages) cost[u.role === 'router' || u.role === 'answer' ? 'call' : 'harness'] += costUsd(u.usage);
  return {
    scenario: sc.id,
    run,
    pass: verdict.pass && tone !== null && tone.pass,
    failures: verdict.failures,
    tone,
    error,
    turns: played.observed.turns,
    ending: played.observed.ending,
    transcript: played.transcript,
    cost,
  };
}

/** True when this file is the script being run, not a module a test imported. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
