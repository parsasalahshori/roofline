import { getAlertFacts, claimNowAlert, listAlertRecipients, withTenant, type AlertFacts, type AlertRecipient } from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { reportJobError } from '../jobs/scheduler/report.ts';
import { systemContext } from '../permissions.ts';

/*
 * Storm alert emails (S1 Task 10). In-app there is no separate alert: the company_storms row IS the
 * in-app alert (the Storm window list and Today read it). Mail goes only through deps.mailer.
 */

const PLACE_FALLBACK = 'your area';

/** 1.25 -> '1.25', 1 -> '1', 1.5 -> '1.5'. */
function sizeText(maxIn: number): string {
  return Number(maxIn.toFixed(2)).toString();
}

function placeOf(facts: AlertFacts): string {
  return facts.placeName ?? PLACE_FALLBACK;
}

function nowEmail(deps: AppDeps, facts: AlertFacts, companyStormId: string): { subject: string; text: string } {
  const size = sizeText(facts.maxIn);
  const place = placeOf(facts);
  return {
    subject: `Hail near ${place} — up to ${size}" (radar-estimated)`,
    text: [
      `Hail is hitting your area now: radar shows hail up to ${size}" (radar-estimated) so far near ${place}.`,
      `Homes in the hail path: ${facts.homesHit}. Your customers hit: ${facts.customersHit}.`,
      "We'll draft a plan when the storm settles.",
      '',
      `${deps.config.APP_ORIGIN}/storm/${companyStormId}`,
    ].join('\n'),
  };
}

function planEmail(deps: AppDeps, facts: AlertFacts, companyStormId: string, taskId: string): { subject: string; text: string } {
  const size = sizeText(facts.maxIn);
  const place = placeOf(facts);
  return {
    subject: `Your storm plan is ready: ${facts.customersHit} customers, ${facts.homesHit} homes`,
    text: [
      `Your storm plan is ready. Radar shows hail up to ${size}" (radar-estimated) near ${place}.`,
      `Homes in the hail path: ${facts.homesHit}. Your customers hit: ${facts.customersHit}.`,
      '',
      `${deps.config.APP_ORIGIN}/storm/${companyStormId}?task=${taskId}`,
    ].join('\n'),
  };
}

/** One email per recipient; a failed send is reported and never stops the others. */
async function sendEach(
  deps: AppDeps,
  companyId: string,
  recipients: AlertRecipient[],
  message: { subject: string; text: string },
): Promise<void> {
  for (const r of recipients) {
    try {
      await deps.mailer.send({ to: r.email, subject: message.subject, text: message.text });
    } catch (err) {
      reportJobError(deps, err, `storm-alert: company ${companyId}`);
    }
  }
}

/** Alerts the owner and office about a company storm ('storm-alert' job body). */
export async function sendStormAlert(deps: AppDeps, companyId: string, companyStormId: string, kind: 'now' | 'plan'): Promise<void> {
  if (kind === 'now') {
    await alertNow(deps, companyId, companyStormId);
    return;
  }
  const facts = await withTenant(deps.pools, systemContext(companyId), (tx) => getAlertFacts(tx, companyStormId));
  if (!facts || facts.planTaskId === null) return;
  await alertPlanReady(deps, companyId, companyStormId, facts.planTaskId);
}

/** Emails the owner and office once per storm when it first matches ("now" alert). */
export async function alertNow(deps: AppDeps, companyId: string, companyStormId: string): Promise<void> {
  const found = await withTenant(deps.pools, systemContext(companyId), async (tx) => {
    const facts = await getAlertFacts(tx, companyStormId);
    if (!facts) return null;
    if (!(await claimNowAlert(tx, facts.id, deps.clock.now()))) return null;
    return { facts, recipients: await listAlertRecipients(tx) };
  });
  if (!found) return;
  await sendEach(deps, companyId, found.recipients, nowEmail(deps, found.facts, companyStormId));
}

/** Emails the owner and office that the plan is drafted. */
export async function alertPlanReady(deps: AppDeps, companyId: string, companyStormId: string, taskId: string): Promise<void> {
  const found = await withTenant(deps.pools, systemContext(companyId), async (tx) => {
    const facts = await getAlertFacts(tx, companyStormId);
    if (!facts) return null;
    return { facts, recipients: await listAlertRecipients(tx) };
  });
  if (!found) return;
  await sendEach(deps, companyId, found.recipients, planEmail(deps, found.facts, companyStormId, taskId));
}
