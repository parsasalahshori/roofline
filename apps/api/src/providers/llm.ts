import type Anthropic from '@anthropic-ai/sdk';
import type { ConversationOutcome, FrontDeskToolName } from '@roofline/shared';
import type { EngineStateSummary } from '../front-desk/engine-state.ts';

// The Llm seam (D1 Task 4). The only real implementation is providers/anthropic/ (Ruling DA).
export type RouteInput = { companyBlock: string; state: EngineStateSummary; callerText: string; channel: 'voice' | 'sms' };
export type RouteDecision = { intent: string; urgent: boolean; mood: 'calm' | 'upset' | 'angry'; route: 'fast' | 'opus' | 'transfer' | 'end'; fastReply: string | null };
export type AnswerInput = { companyId: string; companyBlock: string; history: Anthropic.MessageParam[]; tools: FrontDeskToolName[]; signal: AbortSignal };
export type TurnUsage = { model: string; inputTokens: number; cachedTokens: number; outputTokens: number; firstTokenMs: number | null; totalMs: number };
export type LlmEvent = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: FrontDeskToolName; input: unknown }
  | { type: 'done'; stopReason: 'end_turn' | 'tool_use' | 'refusal' | 'max_tokens'; usage: TurnUsage; assistantContent: Anthropic.ContentBlock[] };
export interface Llm {
  readonly configured: boolean;
  route(i: RouteInput, signal: AbortSignal): Promise<RouteDecision & { usage: TurnUsage }>;
  answer(i: AnswerInput): AsyncIterable<LlmEvent>;
  summarize(i: { companyBlock: string; transcript: string; actions: string[] }): Promise<{ summary: string; outcome: ConversationOutcome; followUps: string[]; usage: TurnUsage }>;
}
export class LlmUnavailableError extends Error {}
