import { listSteps, moveStep, type TenantContext, type Tx, updateTask } from '@roofline/db';
import type { Agent } from '@roofline/shared';
import { createTask, type NewTask, refreshTask } from '../tasks/service.ts';

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

export type LiveStepTask = {
  agent: Agent;
  kind: string;
  title: string;
  summary?: string;
  subjectType?: string;
  subjectId?: string;
  step: NewTask['steps'][number];
};

/** Makes a live task with one step, already running, and returns the task and step ids. The step stays pending. */
export async function runLiveStep(
  tx: Tx,
  ctx: TenantContext,
  task: LiveStepTask,
  now: Date,
): Promise<{ taskId: string; stepId: string }> {
  const { taskId } = await createTask(
    tx,
    ctx,
    {
      agent: task.agent,
      kind: task.kind,
      title: task.title,
      ...(task.summary !== undefined && { summary: task.summary }),
      ...(task.subjectType !== undefined && { subjectType: task.subjectType }),
      ...(task.subjectId !== undefined && { subjectId: task.subjectId }),
      mode: 'live',
      steps: [task.step],
    },
    { now, ip: null, allowInternalStepTypes: true },
  );
  await updateTask(tx, ctx, taskId, { status: 'running' }, now);
  const [step] = await listSteps(tx, ctx, [taskId]);
  if (!step) throw new Error('The task step was not saved.');
  return { taskId, stepId: step.id };
}

/** Makes a finished live note in the caller's transaction and returns its task id. */
export async function writeAgentNote(tx: Tx, ctx: TenantContext, note: AgentNote, now: Date): Promise<string> {
  const { taskId } = await runLiveStep(
    tx,
    ctx,
    {
      agent: note.agent,
      kind: note.kind,
      title: note.title,
      ...(note.summary !== undefined && { summary: note.summary }),
      ...(note.subjectType !== undefined && { subjectType: note.subjectType }),
      ...(note.subjectId !== undefined && { subjectId: note.subjectId }),
      step: { type: 'demo_noop', payload: { label: note.label } },
    },
    now,
  );
  for (const step of await listSteps(tx, ctx, [taskId])) await moveStep(tx, ctx, step.id, ['pending'], { status: 'done' }, now);
  await refreshTask(tx, ctx, taskId, now);
  return taskId;
}
