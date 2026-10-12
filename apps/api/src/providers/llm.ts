import type Anthropic from '@anthropic-ai/sdk';
import type { ClaimStatus, ConversationOutcome, FrontDeskToolName } from '@roofline/shared';
import type { EngineStateSummary } from '../front-desk/engine-state.ts';

// The Llm seam (D1 Task 4). The only real implementation is providers/anthropic/ (Ruling DA).
export type RouteInput = { companyBlock: string; state: EngineStateSummary; callerText: string; channel: 'voice' | 'sms' };
export type RouteDecision = { intent: string; urgent: boolean; mood: 'calm' | 'upset' | 'angry'; route: 'fast' | 'opus' | 'transfer' | 'end'; fastReply: string | null };
export type AnswerInput = { companyId: string; companyBlock: string; history: Anthropic.MessageParam[]; tools: FrontDeskToolName[]; signal: AbortSignal };
export type TurnUsage = { model: string; inputTokens: number; cachedTokens: number; outputTokens: number; firstTokenMs: number | null; totalMs: number };
export type LlmEvent = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: FrontDeskToolName; input: unknown }
  | { type: 'done'; stopReason: 'end_turn' | 'tool_use' | 'refusal' | 'max_tokens'; usage: TurnUsage; assistantContent: Anthropic.ContentBlock[] };

// G1 Agents: drafting and extraction seams (Ruling GX-B).
export const DRAFT_KINDS = ['proposal_follow_up', 'lead_follow_up', 'claims_ask_filed', 'claims_ask_adjuster_date', 'claims_ask_outcome', 'reminder', 'weather_move', 'no_show', 'review_request'] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];
/** facts: plain strings only (dates already formatted). */
export type JobFacts = { jobId: string; customerFirstName: string; companyName: string; repFirstName: string | null; address: string | null; facts: Record<string, string> };
/**
 * The texts the model wrote. A job may be missing from `texts` (the model declined it, or its text
 * failed the guards): callers write that job from the template instead and mark the task "Written
 * from a template". `refused` is true when the model refused the whole request (no texts at all).
 */
export type DraftDropReason = 'guard' | 'claims_guard' | 'too_long' | 'unknown_job' | 'duplicate' | 'review_rule';
export type DraftTextsResult = {
  texts: { jobId: string; body: string }[];
  refused: boolean;
  usage: TurnUsage;
  /** Texts the model wrote that were not used, and why. Absent when none were dropped. Callers may ignore it. */
  dropped?: { jobId: string; reason: DraftDropReason }[];
};
/** What a homeowner's reply says about their claim. `adjusterAt` is an ISO 8601 instant, resolved in the company's time zone. */
export type ClaimReplyFacts = {
  claimNumber?: string;
  insurer?: string;
  adjusterAt?: string;
  decision?: Extract<ClaimStatus, 'approved' | 'partly_approved' | 'denied'>;
};
export const MAX_DRAFT_JOBS = 25;

export interface Llm {
  readonly configured: boolean;
  route(i: RouteInput, signal: AbortSignal): Promise<RouteDecision & { usage: TurnUsage }>;
  answer(i: AnswerInput): AsyncIterable<LlmEvent>;
  summarize(i: { companyBlock: string; transcript: string; actions: string[] }): Promise<{ summary: string; outcome: ConversationOutcome; followUps: string[]; usage: TurnUsage }>;
  /** At most MAX_DRAFT_JOBS (25) jobs per call; more throws RangeError. */
  draftTexts(i: { instruction: DraftKind; facts: JobFacts[] }): Promise<DraftTextsResult>;
  extractClaimReply(i: { text: string; now: Date; timeZone: string }): Promise<{ facts: ClaimReplyFacts; usage: TurnUsage }>;
}
export class LlmUnavailableError extends Error {}
/**
 * The model answered but refused (a stop reason of `refusal`). It is an LlmUnavailableError, so a
 * caller that only handles "no text from the model" treats both alike and falls back to templates.
 */
export class LlmRefusedError extends LlmUnavailableError {}
