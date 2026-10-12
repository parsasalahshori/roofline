import type { TenantContext, Tx } from '@roofline/db';
import type { Agent } from '@roofline/shared';
import { writeLiveNote } from '../tasks/service.ts';

/*
 * Live notes for the G1 agents (Ruling GX-R): a record of something an agent did that needs no
 * approval and sends nothing (a claim updated from a reply, reps nudged about quiet jobs). The task
 * service writes it (`writeLiveNote`): one internal no-op step, done, and the task finished with its
 * events like any plan.
 */

export type AgentNote = {
  agent: Agent;
  kind: string;
  title: string;
  summary?: string;
  subjectType?: string;
  subjectId?: string;
  /** The line the note's single step shows. */
  label: string;
};

/** Makes a finished live note in the caller's transaction and returns its task id. */
export async function writeAgentNote(tx: Tx, ctx: TenantContext, note: AgentNote, now: Date): Promise<string> {
  return writeLiveNote(tx, ctx, note, now);
}
