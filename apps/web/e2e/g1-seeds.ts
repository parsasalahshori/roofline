import type pg from 'pg';
import { createTask, systemContext } from '@roofline/api';
import { withTenant, type Pools } from '@roofline/db';

/*
 * Seeding helpers for the G1 end-to-end specs (Task 18b). Customers, jobs and appointments go in with
 * raw SQL on the owner connection (it bypasses RLS); plans are made with the same `createTask`
 * service the agents use. All names and addresses are invented.
 */

const DAY_MS = 86_400_000;
const LEAD_CUSTOMER = { first: 'Priya', last: 'Natarajan', phone: '+14025550142', address: '123 Example Lane' };

/** A lead job in `companyId` old enough for the Follow-up finder (created 10 days ago, one customer with a textable mobile number, no appointment). Invented name and number. */
export async function seedOldLead(db: pg.Client, companyId: string): Promise<{ jobId: string; customerId: string }> {
  const phones = JSON.stringify([{ e164: LEAD_CUSTOMER.phone, label: 'mobile', primary: true }]);
  const customer = await db.query<{ id: string }>(
    `insert into customers (company_id, display_name, first_name, last_name, phones, sms_consent_status)
     values ($1, $2, $3, $4, $5::jsonb, 'express') returning id`,
    [companyId, `${LEAD_CUSTOMER.first} ${LEAD_CUSTOMER.last}`, LEAD_CUSTOMER.first, LEAD_CUSTOMER.last, phones],
  );
  const customerId = customer.rows[0]!.id;
  const property = await db.query<{ id: string }>(
    `insert into properties (company_id, customer_id, address_line, city, state, zip, address_key)
     values ($1, $2, $3, 'Omaha', 'NE', '68102', $4) returning id`,
    [companyId, customerId, LEAD_CUSTOMER.address, `${LEAD_CUSTOMER.address.toLowerCase()}|68102`],
  );
  const createdAt = new Date(Date.now() - 10 * DAY_MS);
  const job = await db.query<{ id: string }>(
    `insert into jobs (company_id, customer_id, property_id, stage, stage_changed_at, created_at, updated_at)
     values ($1, $2, $3, 'lead', $4, $4, $4) returning id`,
    [companyId, customerId, property.rows[0]!.id, createdAt],
  );
  return { jobId: job.rows[0]!.id, customerId };
}

/** A draft Follow-up plan (kind follow_ups, one send_personal_texts step with one message to `customerId`) made with createTask. */
export async function seedTextsPlan(pools: Pools, companyId: string, customerId: string): Promise<{ taskId: string }> {
  const ctx = systemContext(companyId);
  const now = new Date();
  const { taskId } = await withTenant(pools, ctx, (tx) =>
    createTask(
      tx,
      ctx,
      {
        agent: 'follow_up',
        kind: 'follow_ups',
        title: 'Follow up with 1 lead',
        summary: 'Written from a template',
        expiresAt: new Date(now.getTime() + 2 * DAY_MS),
        steps: [
          {
            type: 'send_personal_texts',
            payload: {
              purpose: 'informational',
              kind: 'lead',
              messages: [
                {
                  customerId,
                  jobId: null,
                  body: `Hi ${LEAD_CUSTOMER.first}, it's Acme Roofing. Would Tuesday at 10 AM or Wednesday at 2 PM work for a free roof inspection?`,
                },
              ],
              dedupePrefix: 'e2e:follow_ups',
            },
          },
        ],
      },
      { now, ip: null, allowInternalStepTypes: true },
    ),
  );
  return { taskId };
}

/** A draft Scheduler plan (kind weather_moves, one move_appointment step moving an install to `newDay`, YYYY-MM-DD) made with createTask. */
export async function seedWeatherMovePlan(
  pools: Pools,
  db: pg.Client,
  companyId: string,
): Promise<{ taskId: string; newDay: string; reason: string }> {
  const owner = await db.query<{ user_id: string }>(
    `select user_id from memberships where company_id = $1 and role = 'owner' order by user_id limit 1`,
    [companyId],
  );
  const userId = owner.rows[0]!.user_id;
  // Days in the company's own zone: the install is 3 days out, the new day 6 days out, both 10 AM to 2 PM local.
  const days = await db.query<{ old_day: string; new_day: string; old_start: Date; old_end: Date; new_start: Date; new_end: Date }>(
    `select to_char(d0, 'YYYY-MM-DD') as old_day, to_char(d1, 'YYYY-MM-DD') as new_day,
            (d0 + time '10:00') at time zone tz as old_start, (d0 + time '14:00') at time zone tz as old_end,
            (d1 + time '10:00') at time zone tz as new_start, (d1 + time '14:00') at time zone tz as new_end
       from (select c.timezone as tz, ((now() at time zone c.timezone)::date + 3) as d0, ((now() at time zone c.timezone)::date + 6) as d1
               from companies c where c.id = $1) t`,
    [companyId],
  );
  const d = days.rows[0]!;
  const appointment = await db.query<{ id: string }>(
    `insert into appointments (company_id, kind, title, assigned_user_id, starts_at, ends_at, status, source)
     values ($1, 'install', 'Roof install', $2, $3, $4, 'scheduled', 'manual') returning id`,
    [companyId, userId, d.old_start, d.old_end],
  );
  const reason = 'Rain is forecast on the install day, so it moves to a clear day.';
  const ctx = systemContext(companyId);
  const now = new Date();
  const { taskId } = await withTenant(pools, ctx, (tx) =>
    createTask(
      tx,
      ctx,
      {
        agent: 'scheduler',
        kind: 'weather_moves',
        title: 'Rain on the install day: move 1 install?',
        summary: 'Bad weather is forecast; these installs can move to a clear day.',
        expiresAt: new Date(d.old_start.getTime()),
        steps: [
          {
            type: 'move_appointment',
            payload: {
              appointmentId: appointment.rows[0]!.id,
              start: d.new_start.toISOString(),
              end: d.new_end.toISOString(),
              userId,
              reason,
            },
          },
        ],
      },
      { now, ip: null, allowInternalStepTypes: true },
    ),
  );
  return { taskId, newDay: d.new_day, reason };
}
