import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { audit, companySettings, readAgentValues, settingsRowId, withTenant } from '@roofline/db';
import { AGENT_VALUE_FIELDS, AgentValuesPatch } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { requireCapability } from '../permissions.ts';
import { assertKnownFields, parse } from '../validate.ts';

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
    const values = await withTenant(pools, req.ctx, async (tx) => {
      await settingsRowId(tx, req.ctx); // makes the default row if it is somehow missing
      return readAgentValues(tx, req.ctx);
    });
    res.json(values);
  });

  router.patch('/', requireCapability('company_admin'), async (req, res) => {
    const { ctx } = req;
    // An empty body is allowed here: it reads the current values and writes nothing.
    const changes = parse(AgentValuesPatch, assertKnownFields(req.body, AGENT_VALUE_FIELDS, { allowEmpty: true }));
    const touched = Object.keys(changes);
    const now = clock.now();

    const result = await withTenant(pools, ctx, async (tx) => {
      const id = await settingsRowId(tx, ctx);
      const before = await readAgentValues(tx, ctx, { lock: true });
      if (touched.length === 0) return before;
      await tx
        .update(companySettings)
        .set({ ...changes, updatedAt: now })
        .where(eq(companySettings.companyId, ctx.companyId));
      const after = await readAgentValues(tx, ctx);
      await audit(tx, ctx, {
        action: 'settings.update',
        targetType: 'company_settings',
        targetId: id,
        after: { fields: touched },
        ip: req.ip ?? null,
        at: now,
      });
      return after;
    });
    res.json(result);
  });

  return router;
}
