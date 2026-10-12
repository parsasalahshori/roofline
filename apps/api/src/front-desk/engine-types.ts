import type Anthropic from '@anthropic-ai/sdk';
import type { ConversationChannel, FrontDeskToolName, FRONT_DESK_TOOLS, IdentityLevel, TransferReason, WorkHours } from '@roofline/shared';
import type { z } from 'zod';
import type { AppDeps } from '../app.ts';

/*
 * Shared types for the D1 Task 6 conversation engine. Type-only: every package imports from here.
 * Signatures follow the Task 6 brief.
 */

export type EngineEvent =
  | { type: 'say'; text: string }
  | { type: 'filler'; text: string }
  | { type: 'handoff'; reason: TransferReason; summary: string; urgent: boolean }
  | { type: 'end'; reason: 'goodbye' | 'spam' | 'silence' | 'limit' }
  | { type: 'turn_saved'; turnId: string };

/** The state of one conversation, server-side only. `history` is append-only. */
export type ConversationState = {
  companyId: string;
  conversationId: string;
  channel: ConversationChannel;
  phone: string;
  callId: string | null;
  identity: IdentityLevel;
  /** Set by verify_caller / phone match; null until known. */
  customerId: string | null;
  /** Ids the model has been shown. Tools may only use ids in this set. */
  shownIds: Set<string>;
  /** Full Anthropic content blocks, append-only (never edited or removed). */
  history: Anthropic.MessageParam[];
  /** The frozen company block text, built once at start() and never changed (cache prefix). */
  companyBlock: string;
  repName: string | null;
  startedAt: Date;
  /** Caller turns so far. */
  turns: number;
  failedUnderstanding: number;
  askedForPersonCount: number;
  taskInProgress: boolean;
  /** Next conversation_turns.position. */
  nextPosition: number;
  mode: 'normal' | 'message_only';
  /** Consecutive model failures within the call (two in a row -> handoff). */
  modelErrors: number;
  /** D1 Task 12: the caller objected to recording; turns are saved with text '' from then on. Absent = false. */
  transcriptOff?: boolean;
  /** D1 Task 19: the company's move/cancel settings at start(); decides which tools this conversation is offered. */
  /** D1 RC-2: set by take_message after it emails the on-call staff about an urgent message; read by the engine's handoff. Absent = false. */
  urgentNoticeSent?: boolean;
  toolSettings?: { canMove: boolean; canCancel: boolean };
};

export type ToolContext = { deps: AppDeps; companyId: string; conversation: ConversationState; now: Date };

export type ToolResult = { ok: boolean; forModel: string; shownIds?: string[]; action?: string };

export type ToolHandler<N extends FrontDeskToolName> = (
  ctx: ToolContext,
  input: z.infer<(typeof FRONT_DESK_TOOLS)[N]['input']>,
) => Promise<ToolResult>;

export type ToolHandlers = Partial<{ [N in FrontDeskToolName]: ToolHandler<N> }>;

export type Engine = {
  start(i: { companyId: string; channel: 'voice' | 'sms'; phone: string; callId?: string; companyNumber?: string }): Promise<ConversationState>;
  turn(state: ConversationState, callerText: string, signal: AbortSignal): AsyncIterable<EngineEvent>;
  interrupted(state: ConversationState, spoken: string): Promise<void>;
  /** Appended to history as a mid-conversation { role: 'system', content } message. */
  note(state: ConversationState, systemNote: string): void;
};

/** What the company block is built from (all plain data; the engine loads it with loadCompanyBlockInput). */
export type CompanyBlockInput = {
  name: string;
  timezone: string;
  city: string | null;
  state: string | null;
  /** Weekday -> [open, close] pairs, 24h "HH:MM" (shared WorkHours). */
  workHours: WorkHours;
  /** Free text from settings (front_desk_facts, at most 2000 chars). */
  facts: string;
  /** Short list of service names, e.g. ['Roof inspections', 'Storm damage repair']. */
  services: string[];
  towns: string[];
  repName: string | null;
  canMove: boolean;
  canCancel: boolean;
};
