/**
 * YES replies to a storm text (S1 Task 21).
 *
 * A customer who texts back YES (isYesReply) to the NEWEST storm text we sent them (within 14 days)
 * becomes a Lead job (source 'storm', storm_id) with a Today follow-up (jobs.next_step). It happens
 * once per storm text: a second YES after the first creates nothing. The caller (the Twilio hook)
 * has already stored the inbound message and handled STOP / HELP / START.
 */
import { and, desc, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { isYesReply, localDate, NEXT_STEP_MAX } from '@roofline/shared';
import { companies, createJob, customers, jobs, properties, updateJob, type TenantContext, type Tx } from '@roofline/db';

/** A storm text older than this no longer takes a YES. */
export const STORM_REPLY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The newest storm text actually sent to the customer (status sent or delivered; blocked, scheduled
 * and failed texts never reached them): which storm, and its sent_at.
 */
async function newestStormText(tx: Tx, customerId: string): Promise<{ stormId: string; at: Date } | null> {
  const result = await tx.execute(sql`
    select cs.storm_id as storm_id, m.sent_at as at
    from messages m
    join agent_task_steps s on s.id = m.step_id
    join agent_tasks t on t.id = s.task_id
    join company_storms cs on cs.id = t.subject_id
    where m.customer_id = ${customerId}
      and m.direction = 'out'
      and m.channel = 'sms'
      and m.step_id is not null
      and m.status in ('sent', 'delivered')
      and s.type = 'send_sms_batch'
      and t.kind = 'storm_plan'
      and t.subject_type = 'company_storm'
    order by m.sent_at desc, m.id desc
    limit 1`);
  const row = result.rows[0];
  if (!row) return null;
  return { stormId: row.storm_id as string, at: new Date(row.at as string | Date) };
}

/** Whether the customer already texted a YES after that sent storm text (the anchor is its sent_at) (not counting this message). */
async function repliedYesBefore(tx: Tx, customerId: string, messageId: string, after: Date): Promise<boolean> {
  const result = await tx.execute(sql`
    select body from messages
    where customer_id = ${customerId} and direction = 'in' and id <> ${messageId} and created_at > ${after.toISOString()}`);
  return result.rows.some((r) => isYesReply(r.body as string));
}

const CLOSED = ['won', 'installed', 'lost'] as const;

/**
 * Returns `{ consumed: true }` when the message was a YES to the newest storm text and a Lead job was
 * created or given the follow-up; else `{ consumed: false }` and nothing is written.
 */
export async function onStormReply(
  tx: Tx,
  ctx: TenantContext,
  message: { id: string; customerId: string | null; body: string },
  now: Date,
): Promise<{ consumed: boolean }> {
  const none = { consumed: false };
  const customerId = message.customerId;
  if (customerId === null || !isYesReply(message.body)) return none;

  const text = await newestStormText(tx, customerId);
  if (text === null || now.getTime() - text.at.getTime() > STORM_REPLY_WINDOW_MS) return none;
  if (await repliedYesBefore(tx, customerId, message.id, text.at)) return none;

  const [customer] = await tx
    .select({ firstName: customers.firstName })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  if (!customer) return none;
  const [company] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
  const today = localDate(now, company?.timezone ?? 'America/Chicago');
  const first = customer.firstName?.trim() || 'Customer';
  const nextStep = `${first} replied YES to the storm text`.slice(0, NEXT_STEP_MAX);

  const open = await tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.customerId, customerId), isNull(jobs.archivedAt), notInArray(jobs.stage, [...CLOSED])))
    .orderBy(desc(jobs.createdAt), desc(jobs.id));
  const existing = open.find((j) => j.stormId === text.stormId) ?? open[0];
  if (existing) {
    // 'lead' is the first stage, so an open job is never earlier than a lead.
    await updateJob(tx, ctx, existing.id, { nextStep, nextStepOn: today }, { now });
    if (existing.stormId === null) {
      await tx.update(jobs).set({ stormId: text.stormId }).where(and(eq(jobs.id, existing.id), isNull(jobs.stormId)));
    }
    return { consumed: true };
  }

  const [property] = await tx
    .select({ id: properties.id })
    .from(properties)
    .where(and(eq(properties.customerId, customerId), isNull(properties.archivedAt)))
    .orderBy(desc(properties.createdAt), desc(properties.id))
    .limit(1);
  if (!property) return none;
  await createJob(
    tx,
    ctx,
    { customerId, propertyId: property.id, stage: 'lead', source: 'storm', stormId: text.stormId, nextStep, nextStepOn: today },
    { now },
  );
  return { consumed: true };
}
