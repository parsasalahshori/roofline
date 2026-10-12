import { stormResultCounts, type TenantContext, type Tx } from '@roofline/db';
import { isYesReply } from '@roofline/shared';

/** Mirrors apps/web/src/features/storm/types.ts StormResultsView exactly. */
export type StormResultsView = {
  textsSent: number;
  textsDelivered: number;
  replies: number;
  yesReplies: number;
  emailsSent: number;
  unsubscribes: number;
  doorsKnocked: number;
  wantsCheck: number;
  adSpendCents: number;
  adMaxCents: number;
  adClicks: number;
  landingRequests: number;
  inspectionsBooked: number;
};

/** What the storm's plan did so far. All zeros when the storm has no plan. */
export async function stormResults(tx: Tx, ctx: TenantContext, companyStormId: string): Promise<StormResultsView> {
  const c = await stormResultCounts(tx, ctx, companyStormId);
  return {
    textsSent: c.textsSent,
    textsDelivered: c.textsDelivered,
    replies: c.replyBodies.length,
    yesReplies: c.replyBodies.filter(isYesReply).length,
    emailsSent: c.emailsSent,
    unsubscribes: c.unsubscribes,
    doorsKnocked: c.doorsKnocked,
    wantsCheck: c.wantsCheck,
    adSpendCents: c.adSpendCents,
    adMaxCents: c.adMaxCents,
    adClicks: c.adClicks,
    landingRequests: c.landingRequests,
    inspectionsBooked: c.inspectionsBooked,
  };
}
