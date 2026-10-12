import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_WORK_HOURS, guardSentence } from '@roofline/shared';
import { ConfigError, loadConfig, type Config } from '../../config.ts';
import { buildCompanyBlock } from '../../front-desk/prompt.ts';
import type { EngineStateSummary } from '../../front-desk/engine-state.ts';
import type { Llm } from '../../providers/llm.ts';
import { anthropicFor } from '../../providers/anthropic/index.ts';
import { r2For } from '../../providers/r2.ts';
import { SmokeRefused, assertConfirmed } from './guards.ts';

/*
 * Front Desk smoke, by hand only (D1 Task 27). It talks to the real Claude service and costs a few
 * cents, so every mode needs --confirm-real-providers, and nothing in CI or the test suite runs it.
 * It never places a call or sends a text: the calls and texts of the runbook
 * (docs/superpowers/d1-manual-smoke.md) are made by a person on test phones.
 *
 *   npm run smoke:front-desk -w @roofline/api -- --preflight --confirm-real-providers
 *   npm run smoke:front-desk -w @roofline/api -- --llm --confirm-real-providers
 *   npm run smoke:front-desk -w @roofline/api -- --llm --record <dir> --confirm-real-providers
 *
 * --preflight lists which settings the runbook needs and which are missing (names only, never values).
 * --llm sends five synthetic caller lines to the real router, and two of them to the real answer
 * model, and checks the replies: a price question and a coverage question never reach a caller with a
 * number or a promise in them, an active leak is routed to a person. Reads the same environment as the API
 * (set -a; . ./.env; set +a). --record <dir> also saves each Claude response there, ids scrubbed, as candidates to replace
 * apps/api/test/fixtures/anthropic/* (the callers are synthetic, so nothing personal is in them). Provider error text is never printed: a failure prints a plain sentence and exits 1.
 */

export const USAGE =
  'Usage: npm run smoke:front-desk -w @roofline/api -- (--preflight | --llm [--record <dir>]) --confirm-real-providers';

const CONFIRM_FLAG = '--confirm-real-providers';
const MODES = ['--preflight', '--llm'] as const;
type Mode = (typeof MODES)[number];
const GENERIC_FAILURE = 'The Claude service turned this down or could not be reached.';
const MODEL_TIMEOUT_MS = 30_000;

export type SmokeIo = { log(line: string): void; error(line: string): void };

const consoleIo: SmokeIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export type Args = { mode: Mode; argv: readonly string[]; recordDir: string | null };

/** The one mode asked for, or null when the arguments are not one valid combination. */
export function parseArgs(argv: readonly string[]): Args | null {
  const seen: string[] = [];
  let recordDir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--record') {
      const value = argv[i + 1];
      if (recordDir !== null || value === undefined || value.startsWith('--')) return null;
      recordDir = value;
      i++;
      continue;
    }
    if (arg !== CONFIRM_FLAG && !(MODES as readonly string[]).includes(arg)) return null;
    if (seen.includes(arg)) return null;
    seen.push(arg);
  }
  const modes = seen.filter((arg): arg is Mode => (MODES as readonly string[]).includes(arg));
  if (modes.length !== 1) return null;
  if (recordDir !== null && modes[0] !== '--llm') return null;
  return { mode: modes[0]!, argv: seen, recordDir };
}

/** Replaces the provider's generated ids, which differ on every call, with fixed ones. */
export function scrubIds(text: string): string {
  return text
    .replace(/\b(msg|req|toolu|srvtoolu)_[A-Za-z0-9]+/g, '$1_fixture')
    .replace(/\b(org|workspace)_[A-Za-z0-9-]+/g, '$1_fixture');
}

/** A fetch that passes every call through and saves a scrubbed copy of each response body in `dir`. */
function recordingFetch(dir: string, saved: Promise<void>[]): typeof fetch {
  mkdirSync(dir, { recursive: true });
  let n = 0;
  return async (input, init) => {
    const response = await fetch(input, init);
    const index = String(++n).padStart(2, '0');
    const copy = response.clone();
    const streamed = (response.headers.get('content-type') ?? '').includes('event-stream');
    saved.push(
      copy.text().then((body) => {
        writeFileSync(join(dir, `${index}-${String(response.status)}.${streamed ? 'sse' : 'json'}`), scrubIds(body));
      }),
    );
    return response;
  };
}

export type Check = { name: string; ok: boolean; required: boolean; hint: string };

/** What the runbook needs from the environment. Pure: reads the config, prints nothing, never shows a value. */
export function preflightChecks(config: Config): Check[] {
  return [
    { name: 'ANTHROPIC_API_KEY', ok: Boolean(config.ANTHROPIC_API_KEY), required: true, hint: 'set the Claude API key' },
    {
      name: 'Router and answer models',
      ok: config.FRONT_DESK_ROUTER_MODEL === 'claude-haiku-5-5' && config.FRONT_DESK_ANSWER_MODEL === 'claude-opus-5-5',
      required: false,
      hint: 'the models are not the defaults (claude-haiku-5-5 and claude-opus-5-5)',
    },
    {
      name: 'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN',
      ok: Boolean(config.TWILIO_ACCOUNT_SID) && Boolean(config.TWILIO_AUTH_TOKEN),
      required: true,
      hint: 'set the Twilio master credentials',
    },
    {
      name: 'TWILIO_TEST_CALLER_NUMBER',
      ok: Boolean(config.TWILIO_TEST_CALLER_NUMBER),
      required: true,
      hint: 'set the Roofline-owned test number the forwarding test calls from',
    },
    {
      name: 'PUBLIC_BASE_URL is https',
      ok: config.PUBLIC_BASE_URL.startsWith('https://'),
      required: true,
      hint: 'Twilio signs webhooks over the public https address',
    },
    {
      name: 'RELAY_PUBLIC_URL is wss',
      ok: config.RELAY_PUBLIC_URL.startsWith('wss://'),
      required: true,
      hint: 'ConversationRelay needs a public wss:// address',
    },
    { name: 'FAKE_PROVIDERS is off', ok: !config.FAKE_PROVIDERS, required: true, hint: 'unset FAKE_PROVIDERS for a real run' },
    {
      name: 'R2 recording storage',
      ok: r2For(config) !== null,
      required: false,
      hint: 'R2 is not wired into this build; the recording step of the runbook cannot be checked yet',
    },
  ];
}

const STATE: EngineStateSummary = {
  verified: false,
  turns: 1,
  identity: 'unknown',
  channel: 'voice',
  taskInProgress: false,
  failedUnderstanding: 0,
};

type Line = { text: string; check: 'plain' | 'price' | 'coverage' | 'leak' | 'recording' };

const LINES: readonly Line[] = [
  { text: 'Hi, a storm came through and I would like someone to look at my roof.', check: 'plain' },
  { text: "What's the price for a new roof?", check: 'price' },
  { text: 'Will my insurance cover all of it?', check: 'coverage' },
  { text: 'Water is coming through my ceiling right now!', check: 'leak' },
  { text: "Please stop recording me, I don't want to be recorded.", check: 'recording' },
];

const COMPANY_BLOCK = buildCompanyBlock({
  name: 'Smoke Test Roofing',
  timezone: 'America/Chicago',
  city: 'Omaha',
  state: 'NE',
  workHours: DEFAULT_WORK_HOURS,
  facts: 'Roof inspections, repairs and replacements. Closed on holidays.',
  services: ['Roof inspections', 'Storm damage repair'],
  towns: ['Omaha'],
  repName: 'Sam',
  canMove: true,
  canCancel: true,
});

/** A sentence that quotes a number or promises coverage, after the guards had their say. */
function slipsPastGuards(kind: 'price' | 'coverage', spoken: string): boolean {
  if (kind === 'price') return /\$|\bdollars?\b|\bgrand\b|\d{3,}/.test(spoken);
  return /\b(will|would)\s+(pay|cover)\b|\bguarantee/i.test(spoken);
}

async function answerText(llm: Llm, text: string): Promise<{ text: string; firstTokenMs: number | null; totalMs: number }> {
  let spoken = '';
  let firstTokenMs: number | null = null;
  let totalMs = 0;
  for await (const event of llm.answer({
    companyId: 'smoke',
    companyBlock: COMPANY_BLOCK,
    history: [{ role: 'user', content: text }],
    tools: ['take_message'],
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  })) {
    if (event.type === 'text') spoken += event.text;
    if (event.type === 'done') {
      firstTokenMs = event.usage.firstTokenMs;
      totalMs = event.usage.totalMs;
    }
  }
  return { text: spoken, firstTokenMs, totalMs };
}

/** The real-model round trip. Returns the number of checks that failed. */
async function runLlm(llm: Llm, io: SmokeIo): Promise<number> {
  let failed = 0;
  const verdict = (ok: boolean, label: string) => {
    io.log(`  ${ok ? 'ok     ' : 'FAILED '} ${label}`);
    if (!ok) failed += 1;
  };

  for (const line of LINES) {
    io.log(`Caller: ${line.text}`);
    const decision = await llm.route(
      { companyBlock: COMPANY_BLOCK, state: STATE, callerText: line.text, channel: 'voice' },
      AbortSignal.timeout(MODEL_TIMEOUT_MS),
    );
    io.log(
      `  router: route=${decision.route} intent=${decision.intent} urgent=${String(decision.urgent)} mood=${decision.mood} in ${decision.usage.totalMs} ms`,
    );
    if (line.check === 'leak') verdict(decision.urgent || decision.route === 'transfer', 'an active leak is urgent or goes to a person');
    if (line.check === 'recording') verdict(/record/i.test(decision.intent), 'the recording objection is recognised');

    if (line.check === 'price' || line.check === 'coverage') {
      const answer = await answerText(llm, line.text);
      const guarded = guardSentence(answer.text, { repName: 'Sam' });
      io.log(
        `  answer: first word ${answer.firstTokenMs ?? 'n/a'} ms, total ${answer.totalMs} ms, guard hits: ${guarded.hits.join(', ') || 'none'}`,
      );
      io.log(`  spoken: ${guarded.text}`);
      verdict(!slipsPastGuards(line.check, guarded.text), `${line.check} never reaches the caller as a number or a promise`);
    }
  }
  return failed;
}

/** Runs one smoke mode and returns the exit code. */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv, io: SmokeIo = consoleIo): Promise<number> {
  const args = parseArgs(argv);
  if (!args) {
    io.error(USAGE);
    return 1;
  }

  try {
    // Before any settings are read or any provider is touched.
    assertConfirmed(args.argv, CONFIRM_FLAG);

    let config: Config;
    try {
      config = loadConfig(env);
    } catch (err) {
      if (err instanceof ConfigError) throw new SmokeRefused('The API settings are not valid. Load your .env first (set -a; . ./.env; set +a).');
      throw err;
    }

    if (args.mode === '--preflight') {
      const checks = preflightChecks(config);
      for (const check of checks) io.log(`${check.ok ? 'ok     ' : check.required ? 'MISSING' : 'note   '} ${check.name}${check.ok ? '' : `: ${check.hint}`}`);
      return checks.some((check) => check.required && !check.ok) ? 1 : 0;
    }

    // --llm
    const saved: Promise<void>[] = [];
    const llm = anthropicFor(config, args.recordDir === null ? undefined : recordingFetch(args.recordDir, saved));
    if (llm === null) throw new SmokeRefused('Set ANTHROPIC_API_KEY first.');
    const failed = await runLlm(llm, io);
    await Promise.all(saved);
    if (args.recordDir !== null) io.log(`Saved ${saved.length} scrubbed responses in ${args.recordDir}. Read them before copying any into the fixtures.`);
    io.log(failed === 0 ? 'All checks passed.' : `${failed} check(s) failed.`);
    return failed === 0 ? 0 : 1;
  } catch (err) {
    io.error(err instanceof SmokeRefused ? err.message : GENERIC_FAILURE);
    return 1;
  }
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
