import { eq } from 'drizzle-orm';
import {
  agentCompanyFacts,
  busyFor,
  companySettings,
  memberHours,
  noShowTaskExists,
  noShowTarget,
  g1AgentOn,
  withTenant,
} from '@roofline/db';
import { DEFAULT_WORK_HOURS, type WorkHours } from '@roofline/shared';
import type { AppDeps } from '../../app.ts';
import { LlmUnavailableError, type JobFacts } from '../../providers/llm.ts';
import { createTask } from '../../tasks/service.ts';
import { draftBodyOk, FROM_TEMPLATE, systemCtx } from '../common.ts';
import { formatSlot, pickTwoSlots } from '../followup/draft.ts';

const MAX_BODY = 300;
const DAY_MS = 86_400_000;

/**
 * One reschedule text for a missed visit: one approval task offering two times. The model is called
 * outside any transaction; the checks run again just before the task is made. Nothing logs text.
 */
export async function runNoShow(deps: AppDeps, companyId: string, appointmentId: string): Promise<void> {
  const ctx = systemCtx(companyId);
  const now = deps.clock.now();

  const plan = await withTenant(deps.pools, ctx, async (tx) => {
    const company = await agentCompanyFacts(tx, ctx);
    if (!company || (company.status !== 'active' && company.status !== 'trial')) return null;
    if (!(await g1AgentOn(tx, ctx, 'scheduler'))) return null;
    const target = await noShowTarget(tx, ctx, appointmentId);
    if (!target) return null;
    if (await noShowTaskExists(tx, ctx, appointmentId)) return null;

    let workHours: WorkHours;
    let busy: Awaited<ReturnType<typeof busyFor>> extends Map<string, infer V> ? V : never = [];
    if (target.assignedUserId !== null) {
      const id = target.assignedUserId;
      workHours = (await memberHours(tx, ctx, id)).workHours;
      busy = (await busyFor(tx, ctx, [id], now, new Date(now.getTime() + 5 * DAY_MS))).get(id) ?? [];
    } else {
      const [row] = await tx.select({ workHours: companySettings.workHours }).from(companySettings).where(eq(companySettings.companyId, companyId)).limit(1);
      workHours = (row?.workHours ?? DEFAULT_WORK_HOURS) as WorkHours;
    }
    const slots = pickTwoSlots({ workHours, busy, propertyId: target.propertyId, timeZone: company.timeZone, now });
    if (slots === null) return null;
    return { company, target, slots };
  });
  if (!plan) return;
  const { company, target, slots } = plan;
  const tz = company.timeZone;

  const facts: JobFacts = {
    jobId: appointmentId,
    customerFirstName: target.customerFirstName,
    companyName: company.name,
    repFirstName: target.repFirstName,
    address: null,
    facts: { originalWhen: formatSlot(target.startsAt, tz), slot1: slots[0], slot2: slots[1] },
  };
  let drafted: string | undefined;
  try {
    const res = await deps.llm.draftTexts({ instruction: 'no_show', facts: [facts] });
    if (!res.refused) drafted = res.texts.find((x) => x.jobId === appointmentId)?.body;
  } catch (err) {
    if (!(err instanceof LlmUnavailableError)) throw err;
  }

  const first = target.customerFirstName;
  const usedTemplate = drafted === undefined || !draftBodyOk(drafted, { repName: null, maxChars: MAX_BODY });
  const body = usedTemplate
    ? `Hi ${first}, it's ${target.repFirstName ?? 'our team'} at ${company.name}. Sorry we missed you today. We can come by ${slots[0]} or ${slots[1]}. Reply with the one that works.`
    : drafted;

  await withTenant(deps.pools, ctx, async (tx) => {
    const again = await noShowTarget(tx, ctx, appointmentId);
    if (!again) return;
    if (await noShowTaskExists(tx, ctx, appointmentId)) return;
    await createTask(
      tx,
      ctx,
      {
        agent: 'scheduler',
        kind: 'no_show',
        title: `Reschedule ${first}'s ${target.kind} (missed)`,
        summary: usedTemplate ? FROM_TEMPLATE : 'Drafted for the missed visit.',
        subjectType: 'appointment',
        subjectId: appointmentId,
        expiresAt: new Date(now.getTime() + 2 * DAY_MS),
        steps: [
          {
            type: 'send_personal_texts',
            payload: {
              purpose: 'informational',
              kind: 'no_show',
              messages: [{ customerId: target.customerId, jobId: target.jobId, body }],
              dedupePrefix: `no_show:${appointmentId}`,
            },
          },
        ],
      },
      { now, allowInternalStepTypes: true },
    );
  });
}
