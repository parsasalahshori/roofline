import { hailHitsForProperties, propertiesForCustomer, withTenant } from '@roofline/db';
import type { ToolHandler } from '../engine-types.ts';
import { systemCtx } from './system-ctx.ts';

/*
 * D1 Task 7: hail_at_my_home. Verified callers only. States only what the company's radar record
 * shows; it never says there was or was not damage.
 */

const DAYS = 30;
const NOT_VERIFIED = "I need to verify who you are before I can look at your home. Please give me your name and street address first.";
const NO_CUSTOMER = "I don't have a customer record for this caller yet.";
const NO_HOME = 'I have no home on file for this caller.';
const NOT_SHOWN = "I can't use that home. Please pick one I have listed.";
const NO_RECORD = `There is no hail record for the home in the last ${DAYS} days in the company's radar data. That does not mean there was or was not damage.`;

function monthDay(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d)));
}

export const hailAtMyHome: ToolHandler<'hail_at_my_home'> = async (ctx, input) => {
  const { customerId, identity, shownIds } = ctx.conversation;
  if (identity !== 'verified') return { ok: false, forModel: NOT_VERIFIED };
  if (customerId === null) return { ok: false, forModel: NO_CUSTOMER };
  const tctx = systemCtx(ctx.companyId);

  return withTenant(ctx.deps.pools, tctx, async (tx) => {
    const all = await propertiesForCustomer(tx, tctx, customerId);
    let used = all;
    if (input.propertyId !== null) {
      used = shownIds.has(input.propertyId) ? all.filter((p) => p.id === input.propertyId) : [];
      if (used.length === 0) return { ok: false, forModel: NOT_SHOWN };
    }
    if (used.length === 0) return { ok: false, forModel: NO_HOME };
    const ids = used.map((p) => p.id);
    const hits = await hailHitsForProperties(tx, tctx, ids, DAYS, ctx.now);
    if (hits.length === 0) return { ok: true, forModel: NO_RECORD, shownIds: ids };
    const lines = hits.map((h) => {
      const street = used.find((p) => p.id === h.propertyId)?.street ?? 'the home';
      const size = h.hailSizeInches === null ? 'hail' : `hail of about ${h.hailSizeInches} inches`;
      return `Radar-estimated ${size} near ${street} on ${monthDay(h.occurredOn)}.`;
    });
    lines.push('This is a radar estimate, not a finding about damage.');
    return { ok: true, forModel: lines.join(' '), shownIds: ids };
  });
};
