import { listSteps, moveStep, type TenantContext, type Tx, updateTask } from '@roofline/db';
import type { Agent } from '@roofline/shared';
import { createTask, refreshTask } from '../tasks/service.ts';

/*
 * Live notes for the G1 agents (Ruling GX-R): a record of something an agent did that needs no
 * approval and sends nothing (a claim updated from a reply, reps nudged about quiet jobs). The task
 * service wants one step per plan, so the note carries one internal no-op step, marked done here,
 * and the task is finished through `refreshTask`, which writes its `finished` event like any plan.
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
  const { taskId } = await createTask(
    tx,
    ctx,
    {
      agent: note.agent,
      kind: note.kind,
      title: note.title,
      ...(note.summary !== undefined && { summary: note.summary }),
      ...(note.subjectType !== undefined && { subjectType: note.subjectType }),
      ...(note.subjectId !== undefined && { subjectId: note.subjectId }),
      mode: 'live',
      steps: [{ type: 'demo_noop', payload: { label: note.label } }],
    },
    { now, allowInternalStepTypes: true },
  );
  await updateTask(tx, ctx, taskId, { status: 'running' }, now);
  for (const step of await listSteps(tx, ctx, [taskId])) await moveStep(tx, ctx, step.id, ['pending'], { status: 'done' }, now);
  await refreshTask(tx, ctx, taskId, now);
  return taskId;
}
