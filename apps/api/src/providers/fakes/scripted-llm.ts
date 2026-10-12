import type Anthropic from '@anthropic-ai/sdk';
import { CONVERSATION_OUTCOMES, type FrontDeskToolName } from '@roofline/shared';
import {
  type AnswerInput,
  type Llm,
  type LlmEvent,
  LlmUnavailableError,
  type RouteDecision,
  type RouteInput,
  type TurnUsage,
} from '../llm.ts';

export type ScriptStep =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: FrontDeskToolName; input: unknown; id?: string }
  | { kind: 'refuse' };
export type ScriptRule = { when: RegExp; route: RouteDecision; answer?: ScriptStep[] };
export type Script = ScriptRule[];

export type LlmCall = {
  kind: 'route' | 'answer' | 'summarize';
  request: unknown;
  prefix: string;
};

const USAGE: TurnUsage = { model: 'scripted', inputTokens: 100, cachedTokens: 0, outputTokens: 20, firstTokenMs: 1, totalMs: 2 };
const DEFAULT_ROUTE: RouteDecision = { intent: 'unknown', urgent: false, mood: 'calm', route: 'opus', fastReply: null };
const DEFAULT_ANSWER: ScriptStep[] = [{ kind: 'text', text: 'Sorry, could you say that again?' }];
const CONTINUATION_ANSWER: ScriptStep[] = [{ kind: 'text', text: 'Done.' }];

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function withoutSignal<T extends object>(i: T): unknown {
  const { signal, ...rest } = i as T & { signal?: unknown };
  void signal;
  return structuredClone(rest);
}

type Block = { type?: string; text?: string };

/** The text of the last user message, or null when that message holds only tool_result blocks. */
function lastUserText(history: Anthropic.MessageParam[]): { text: string; continuation: boolean } {
  for (let k = history.length - 1; k >= 0; k--) {
    const m = history[k];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return { text: m.content, continuation: false };
    const blocks = m.content as unknown as Block[];
    if (blocks.length > 0 && blocks.every((b) => b.type === 'tool_result')) return { text: '', continuation: true };
    return { text: blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''), continuation: false };
  }
  return { text: '', continuation: false };
}

/** A deterministic Llm: rules pick the route and the answer. It never reaches the network (Rulings DA, DB). */
export class ScriptedLlm implements Llm {
  readonly configured = true;
  delayMs = 0;
  calls: LlmCall[] = [];
  private failures = 0;
  private toolCounter = 0;

  constructor(
    public readonly script: Script = [],
    private readonly opts: { summary?: string } = {},
  ) {}

  failNext(n = 1): void {
    this.failures = n;
  }

  reset(): void {
    this.calls = [];
    this.failures = 0;
    this.toolCounter = 0;
  }

  private shouldFail(): boolean {
    if (this.failures > 0) {
      this.failures--;
      return true;
    }
    return false;
  }

  async route(i: RouteInput, signal: AbortSignal): Promise<RouteDecision & { usage: TurnUsage }> {
    this.calls.push({ kind: 'route', request: withoutSignal(i), prefix: JSON.stringify({ companyBlock: i.companyBlock }) });
    if (this.shouldFail()) throw new LlmUnavailableError('scripted failure');
    await sleep(this.delayMs, signal);
    const rule = this.script.find((r) => r.when.test(i.callerText));
    return { ...(rule ? rule.route : DEFAULT_ROUTE), usage: USAGE };
  }

  async *answer(i: AnswerInput): AsyncIterable<LlmEvent> {
    this.calls.push({
      kind: 'answer',
      request: withoutSignal(i),
      prefix: JSON.stringify({ tools: i.tools, companyBlock: i.companyBlock }),
    });
    if (this.shouldFail()) throw new LlmUnavailableError('scripted failure');
    await sleep(this.delayMs, i.signal);
    const last = lastUserText(i.history);
    let steps: ScriptStep[];
    if (last.continuation) steps = CONTINUATION_ANSWER;
    else steps = this.script.find((r) => r.when.test(last.text))?.answer ?? DEFAULT_ANSWER;

    let stopReason: 'end_turn' | 'tool_use' | 'refusal' = 'end_turn';
    const content: unknown[] = [];
    for (const step of steps) {
      if (i.signal.aborted) return;
      if (step.kind === 'text') {
        content.push({ type: 'text', text: step.text });
        yield { type: 'text', text: step.text };
      } else if (step.kind === 'tool') {
        const id = step.id ?? `tool_${++this.toolCounter}`;
        content.push({ type: 'tool_use', id, name: step.name, input: step.input });
        stopReason = 'tool_use';
        yield { type: 'tool_use', id, name: step.name, input: step.input };
      } else {
        stopReason = 'refusal';
        break;
      }
    }
    if (i.signal.aborted) return;
    yield { type: 'done', stopReason, usage: USAGE, assistantContent: content as unknown as Anthropic.ContentBlock[] };
  }

  async summarize(i: { companyBlock: string; transcript: string; actions: string[] }) {
    this.calls.push({ kind: 'summarize', request: structuredClone(i), prefix: JSON.stringify({ companyBlock: i.companyBlock }) });
    if (this.shouldFail()) throw new LlmUnavailableError('scripted failure');
    return {
      summary: this.opts.summary ?? 'Scripted summary.',
      outcome: CONVERSATION_OUTCOMES[0],
      followUps: [] as string[],
      usage: USAGE,
    };
  }
}
