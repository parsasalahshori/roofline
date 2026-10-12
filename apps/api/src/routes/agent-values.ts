import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { audit, companySettings, insertDefaultSettings, type TenantContext, type Tx, withTenant } from '@roofline/db';
import { AGENT_VALUE_FIELDS, AgentValuesPatch, type AgentValues } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { requireCapability } from '../permissions.ts';
import { assertKnownFields, parse } from '../validate.ts';

/** The columns behind AgentValues. Their names are the API's field names. */
const VALUE_READ = {
  id: companySettings.id,
  claimsNudgeDays: companySettings.claimsNudgeDays,
  weatherRainPct: companySettings.weatherRainPct,
  weatherGustMph: companySettings.weatherGustMph,
  reminderHour: companySettings.reminderHour,
  followupDays: companySettings.followupDays,
  leadFollowupDays: companySettings.leadFollowupDays,
  reviewLink: companySettings.reviewLink,
  reviewDelayDays: companySettings.reviewDelayDays,
  followupReviews: companySettings.followupReviews,
  followupLeads: companySettings.followupLeads,
  followupProposals: companySettings.followupProposals,
} as const;

type SettingsRow = { id: string; claimsNudgeDays: number[]; followupDays: number[] } & Omit<
  AgentValues,
  'claimsNudgeDays' | 'followupDays'
>;

/** The stored row as the API shows it: the two day lists become fixed-length tuples. */
function valuesOf(row: SettingsRow): AgentValues {
  const [n1, n2, n3] = row.claimsNudgeDays;
  const [f1, f2] = row.followupDays;
  return {
    claimsNudgeDays: [n1!, n2!, n3!],
    weatherRainPct: row.weatherRainPct,
    weatherGustMph: row.weatherGustMph,
    reminderHour: row.reminderHour,
    followupDays: [f1!, f2!],
    leadFollowupDays: row.leadFollowupDays,
    reviewLink: row.reviewLink,
    reviewDelayDays: row.reviewDelayDays,
    followupReviews: row.followupReviews,
    followupLeads: row.followupLeads,
    followupProposals: row.followupProposals,
  };
}

/** The company's settings row, made with the defaults if it is somehow missing. */
async function loadRow(tx: Tx, ctx: TenantContext, lock = false): Promise<SettingsRow> {
  const select = () => {
    const query = tx.select(VALUE_READ).from(companySettings).where(eq(companySettings.companyId, ctx.companyId)).limit(1);
    return lock ? query.for('update') : query;
  };
  let [row] = await select();
  if (!row) {
    await insertDefaultSettings(tx, ctx.companyId);
    [row] = await select();
  }
  return row as SettingsRow;
}

/**
 * `/api/agent-values`: the values behind the G1 agent rules (claims nudges, the scheduler's weather
 * and reminder hour, the follow-up switches and days, the review link). Both routes need
 * `company_admin`. A PATCH changes only the fields it sends, in one transaction with one
 * `settings.update` audit row that names those fields (never their values).
 */
export function agentValueRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  router.get('/', requireCapability('company_admin'), async (req, res) => {
    const row = await withTenant(pools, req.ctx, (tx) => loadRow(tx, req.ctx));
    res.json(valuesOf(row));
  });

  router.patch('/', requireCapability('company_admin'), async (req, res) => {
    const { ctx } = req;
    // An empty body is allowed here: it reads the current values and writes nothing.
    const changes = parse(AgentValuesPatch, assertKnownFields(req.body, AGENT_VALUE_FIELDS, { allowEmpty: true }));
    const touched = Object.keys(changes);
    const now = clock.now();

    const result = await withTenant(pools, ctx, async (tx) => {
      const before = await loadRow(tx, ctx, true);
      if (touched.length === 0) return before;
      await tx
        .update(companySettings)
        .set({ ...changes, updatedAt: now })
        .where(eq(companySettings.companyId, ctx.companyId));
      const after = await loadRow(tx, ctx);
      await audit(tx, ctx, {
        action: 'settings.update',
        targetType: 'company_settings',
        targetId: before.id,
        after: { fields: touched },
        ip: req.ip ?? null,
        at: now,
      });
      return after;
    });
    res.json(valuesOf(result));
  });

  return router;
}
