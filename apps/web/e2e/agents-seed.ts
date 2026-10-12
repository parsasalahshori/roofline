import type pg from 'pg';

/*
 * Agents screen seed for the end-to-end specs. Numbers (minutes, from the time baselines):
 *   stormToday   90 = text_sent 60 units x 1.5 (result {sent: 60}; under the 120 cap)
 *   stormOlder  190 = email_sent 200 x 0.5 = 100 + route_built 2 x 45 = 90   (5 days ago)
 *   estimator    70 = Lopez 20 (1 day ago) + Nguyen 30 (3 days: proposal 20 + exact report 10) + Baker 20 (9 days)
 * Each step carries the `result` that stepMinutes reads (sent / routes), so a recount reproduces the same minutes.
 * Plus one Storm Scout task needing attention and one Estimator draft waiting for approval.
 */

/** What `seedAgentsFixture` made, so specs can find rows by id and title. */
export type AgentsFixture = {
  /** Done Storm Scout task finished today: one `text_sent` step, 60 units = 90 minutes. */
  stormTodayTaskId: string;
  /** Done Storm Scout task finished 5 days ago: `email_sent` 200 units (100 minutes) + `route_built` 2 units (90 minutes). */
  stormOlderTaskId: string;
  /** Done Estimator tasks: 1, 3 and 9 days ago (`proposal_sent` 1 / `proposal_sent` 1 + `exact_report` 1 / `proposal_sent` 1). */
  estimatorTaskIds: string[];
  /** Storm Scout task in needs_attention, with a plain reason. */
  attentionTaskId: string;
  attentionReason: string;
  /** Estimator draft awaiting approval (mode needs_approval, status draft, expires in the future). */
  draftTaskId: string;
  draftTitle: string;
  /** Titles of the seeded tasks (feed and recent-work rows show them). */
  titles: { stormToday: string; stormOlder: string; estimator: string[]; attention: string };
};

/** Seeded numbers the specs assert (minutes). */
export const AGENTS_SEED_MINUTES = { stormToday: 90, stormOlder: 190, estimator: 20 + 30 + 20 } as const;

type StepSeed = { type: string; baseline: string; units: number; perUnit: number; minutes: number; result?: Record<string, number> };

/**
 * Inserts the Agents screen data for one company through the owner connection (raw SQL; the owner
 * role bypasses row security, like `seedTwoCompanies`). Dates are relative to `now` in the company's
 * own time zone (`companies.timezone`).
 */
export async function seedAgentsFixture(db: pg.Client, companyId: string, now: Date): Promise<AgentsFixture> {
  const tz = (await db.query<{ timezone: string }>(`select timezone from companies where id = $1`, [companyId])).rows[0]
    ?.timezone;
  if (!tz) throw new Error('seedAgentsFixture: company not found');
  const owner = (
    await db.query<{ user_id: string }>(
      `select user_id from memberships where company_id = $1 and role = 'owner' order by created_at limit 1`,
      [companyId],
    )
  ).rows[0];
  if (!owner) throw new Error('seedAgentsFixture: company has no owner');

  /** Noon local time, `days` days before today's local date, never after `now`. */
  async function noonDaysAgo(days: number): Promise<Date> {
    const r = await db.query<{ t: Date }>(
      `select least((((($1::timestamptz at time zone $2)::date - $3::int) + time '12:00') at time zone $2), $1::timestamptz) as t`,
      [now, tz, days],
    );
    return r.rows[0]!.t;
  }
  const todayR = await db.query<{ t: Date }>(
    `select least(greatest((($1::timestamptz at time zone $2)::date::timestamp at time zone $2) + interval '1 minute',
                          $1::timestamptz - interval '10 minutes'), $1::timestamptz) as t`,
    [now, tz],
  );
  const finishedToday = todayR.rows[0]!.t;
  const minutesBefore = (d: Date, m: number) => new Date(d.getTime() - m * 60_000);

  let seq = 0;
  const tag = `a1e2e-${now.getTime()}`;

  async function insertTask(args: {
    agent: 'storm_scout' | 'estimator';
    kind: string;
    title: string;
    status: string;
    mode?: string;
    at: Date;
    expiresAt?: Date;
    minutes?: number;
    approved?: boolean;
  }): Promise<string> {
    const r = await db.query<{ id: string }>(
      `insert into agent_tasks (company_id, agent, kind, title, mode, status, expires_at, minutes_saved,
                                approved_by_user_id, approved_at, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) returning id`,
      [
        companyId,
        args.agent,
        args.kind,
        args.title,
        args.mode ?? 'needs_approval',
        args.status,
        args.expiresAt ?? null,
        args.minutes ?? null,
        args.approved ? owner!.user_id : null,
        args.approved ? minutesBefore(args.at, 5) : null,
        args.at,
      ],
    );
    return r.rows[0]!.id;
  }

  async function insertStep(
    taskId: string,
    position: number,
    at: Date,
    s: {
      type: string;
      approvalClass: string;
      status: string;
      step?: StepSeed;
      error?: string;
      /** A valid payload and stored preview, for steps the review screen must render (default: empty). */
      payload?: Record<string, unknown>;
      preview?: Record<string, unknown>;
    },
  ): Promise<string> {
    seq += 1;
    const r = await db.query<{ id: string }>(
      `insert into agent_task_steps (company_id, task_id, position, type, approval_class, status, payload, preview,
                                     idempotency_key, error_plain, baseline_key, units, minutes_per_unit, minutes_saved, result,
                                     created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$15::jsonb,$16::jsonb,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$14) returning id`,
      [
        companyId,
        taskId,
        position,
        s.type,
        s.approvalClass,
        s.status,
        `${tag}-${seq}`,
        s.error ?? null,
        s.step?.baseline ?? null,
        s.step?.units ?? null,
        s.step?.perUnit ?? null,
        s.step?.minutes ?? null,
        s.step?.result ? JSON.stringify(s.step.result) : null,
        at,
        JSON.stringify(s.payload ?? {}),
        JSON.stringify(s.preview ?? {}),
      ],
    );
    return r.rows[0]!.id;
  }

  async function insertEvent(
    taskId: string,
    stepId: string | null,
    kind: string,
    actor: 'agent' | 'system' | 'user',
    at: Date,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    await db.query(
      `insert into agent_task_events (company_id, task_id, step_id, kind, actor_type, actor_user_id, data, at)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [companyId, taskId, stepId, kind, actor, actor === 'user' ? owner!.user_id : null, JSON.stringify(data), at],
    );
  }

  /** A finished task with its done steps and the events a real run leaves. */
  async function doneTask(args: {
    agent: 'storm_scout' | 'estimator';
    kind: string;
    title: string;
    finished: Date;
    approvalClass: string;
    steps: StepSeed[];
    approvedEvent?: boolean;
  }): Promise<string> {
    const total = args.steps.reduce((sum, s) => sum + s.minutes, 0);
    const created = minutesBefore(args.finished, 30);
    const taskId = await insertTask({
      agent: args.agent,
      kind: args.kind,
      title: args.title,
      status: 'done',
      at: args.finished,
      minutes: total,
      approved: true,
    });
    await db.query(`update agent_tasks set created_at = $2 where id = $1`, [taskId, created]);
    await insertEvent(taskId, null, 'created', 'agent', created);
    if (args.approvedEvent) await insertEvent(taskId, null, 'approved', 'user', minutesBefore(args.finished, 5));
    let position = 0;
    for (const step of args.steps) {
      position += 1;
      const stepId = await insertStep(taskId, position, args.finished, {
        type: step.type,
        approvalClass: args.approvalClass,
        status: 'done',
        step,
      });
      await insertEvent(taskId, stepId, 'step_done', 'agent', minutesBefore(args.finished, 1), { units: step.units });
    }
    await insertEvent(taskId, null, 'finished', 'system', args.finished, { steps: args.steps.length });
    return taskId;
  }

  const titles = {
    stormToday: 'Storm plan for Elkhorn',
    stormOlder: 'Storm plan for Millard',
    estimator: ['Proposal for Lopez', 'Proposal for Nguyen', 'Proposal for Baker'],
    attention: 'Storm plan for Papillion',
  };
  const proposal: StepSeed = { type: 'send_proposal', baseline: 'proposal_sent', units: 1, perUnit: 20, minutes: 20 };

  const stormTodayTaskId = await doneTask({
    agent: 'storm_scout',
    kind: 'storm_plan',
    title: titles.stormToday,
    finished: finishedToday,
    approvalClass: 'message',
    approvedEvent: true,
    steps: [{ type: 'send_sms_batch', baseline: 'text_sent', units: 60, perUnit: 1.5, minutes: 90, result: { sent: 60 } }],
  });
  const stormOlderTaskId = await doneTask({
    agent: 'storm_scout',
    kind: 'storm_plan',
    title: titles.stormOlder,
    finished: await noonDaysAgo(5),
    approvalClass: 'message',
    steps: [
      { type: 'send_email_batch', baseline: 'email_sent', units: 200, perUnit: 0.5, minutes: 100, result: { sent: 200 } },
      { type: 'build_routes', baseline: 'route_built', units: 2, perUnit: 45, minutes: 90, result: { routes: 2 } },
    ],
  });
  const estimatorTaskIds = [
    await doneTask({
      agent: 'estimator',
      kind: 'proposal_send',
      title: titles.estimator[0]!,
      finished: await noonDaysAgo(1),
      approvalClass: 'message',
      steps: [proposal],
    }),
    await doneTask({
      agent: 'estimator',
      kind: 'proposal_send',
      title: titles.estimator[1]!,
      finished: await noonDaysAgo(3),
      approvalClass: 'message',
      steps: [
        proposal,
        { type: 'order_exact_report', baseline: 'exact_report', units: 1, perUnit: 10, minutes: 10 },
      ],
    }),
    await doneTask({
      agent: 'estimator',
      kind: 'proposal_send',
      title: titles.estimator[2]!,
      finished: await noonDaysAgo(9),
      approvalClass: 'message',
      steps: [proposal],
    }),
  ];

  // Needs attention: one step the agent could not finish.
  const attentionReason = 'Twilio could not reach 3 numbers.';
  const attentionAt = minutesBefore(now, 120);
  const attentionTaskId = await insertTask({
    agent: 'storm_scout',
    kind: 'storm_plan',
    title: titles.attention,
    status: 'needs_attention',
    at: attentionAt,
    approved: true,
  });
  await insertEvent(attentionTaskId, null, 'created', 'agent', minutesBefore(attentionAt, 30));
  const attentionStep = await insertStep(attentionTaskId, 1, attentionAt, {
    type: 'send_sms_batch',
    approvalClass: 'message',
    status: 'needs_attention',
    error: attentionReason,
  });
  await insertEvent(attentionTaskId, attentionStep, 'step_attention', 'agent', attentionAt);

  // Draft waiting for approval.
  const draftTitle = 'Proposal for Johnson';
  const draftAt = minutesBefore(now, 45);
  const draftTaskId = await insertTask({
    agent: 'estimator',
    kind: 'proposal_send',
    title: draftTitle,
    status: 'draft',
    at: draftAt,
    expiresAt: new Date(now.getTime() + 2 * 24 * 60 * 60_000),
  });
  // A demo text step with a valid payload and stored preview, so the review screen can render and approve it.
  await insertStep(draftTaskId, 1, draftAt, {
    type: 'demo_message',
    approvalClass: 'message',
    status: 'pending',
    payload: { label: draftTitle },
    preview: { title: draftTitle, lines: [] },
  });
  await insertEvent(draftTaskId, null, 'created', 'agent', draftAt);

  return {
    stormTodayTaskId,
    stormOlderTaskId,
    estimatorTaskIds,
    attentionTaskId,
    attentionReason,
    draftTaskId,
    draftTitle,
    titles,
  };
}
