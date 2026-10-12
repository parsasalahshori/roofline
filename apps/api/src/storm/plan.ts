import { createTask, supersedeDraft, type NewTask } from '../tasks/service.ts';
import {
  isAgentPaused,
  linkStormPlan,
  listStormPlanRecipients,
  loadStormPlanFacts,
  lockStormPlan,
  withTenant,
  type StormPlanFacts,
  type Tx,
} from '@roofline/db';
import {
  DEFAULT_STORM_EMAIL_BODY,
  DEFAULT_STORM_EMAIL_SUBJECT,
  DEFAULT_STORM_SMS,
  hailLabel,
  missingStormTokens,
  splitAdBudget,
  stepTypes,
  stormDayLabel,
  stormTitle,
} from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { systemContext } from '../permissions.ts';
import { alertPlanReady } from './alerts.ts';

/*
 * Drafts the approval plan for one company storm (S1 Task 11): a text, an email, door routes and two
 * ad campaigns, each ON unless something is missing, in which case it is saved OFF with a plain
 * reason. Re-drafting replaces a DRAFT plan only; a plan that is running, approved, declined or
 * expired is left alone. This only creates the task; nothing is texted or mailed here.
 */

export const STORM_OFF = {
  textingNotApproved: "Texting isn't approved yet.",
  noSmsRecipients: 'No customers with text consent were hit.',
  emailsOff: 'Storm emails are turned off in Settings.',
  noAddress: 'Add your mailing address in Settings → Company',
  noEmailRecipients: 'No customers with an email address were hit.',
  noHomes: 'No homes were in the hail area.',
  noReps: 'Add a rep or an owner to knock doors.',
  noGoogle: 'No Google Ads account connected',
  noMeta: 'No Facebook and Instagram ad account connected',
  googleBudgetSmall: 'The Google ads budget is too small.',
  metaBudgetSmall: 'The Facebook and Instagram ads budget is too small.',
} as const;

const EMAIL_INCOMPLETE = 'Your email needs your company name, mailing address and unsubscribe link.';
export const STORM_PLAN_ERRORS = {
  notFound: 'We could not find that storm.',
  dismissed: 'This storm was dismissed, so no plan is drafted.',
  changed: 'The plan changed while we were drafting. Please try again.',
} as const;
const PLAN_LIFETIME_MS = 48 * 60 * 60 * 1000;
const MIN_AD_CENTS = 500;
const MAX_DOORS = 1500;
const PLACE_FALLBACK = 'your area';
const GOOGLE_KEYWORDS = ['roof inspection', 'hail damage roof repair', 'roof repair near me', 'free roof inspection'];

type Step = NewTask['steps'][number];

function adCopy(facts: StormPlanFacts): { headline: string; description: string; primaryText: string } {
  const place = facts.placeName ?? PLACE_FALLBACK;
  const size = hailLabel(facts.maxIn);
  const company = facts.company.name;
  return {
    headline: `Hail hit ${place}: free roof check`.slice(0, 120),
    description: `Radar shows hail up to ${size} near you. ${company} offers a free roof check.`.slice(0, 300),
    primaryText:
      `Radar shows hail up to ${size} near ${place}. ${company} offers a free roof check. Send us a message to book yours.`.slice(
        0,
        500,
      ),
  };
}

function buildSteps(
  facts: StormPlanFacts,
  recipients: { smsIds: string[]; emailIds: string[]; fields: Record<string, { hail_size: string; street: string }> },
  companyStormId: string,
  day: string,
): Step[] {
  const { settings } = facts;
  const dedupePrefix = `storm:${companyStormId}`;

  const smsFields: Record<string, Record<string, string>> = {};
  for (const id of recipients.smsIds) {
    const f = recipients.fields[id];
    if (f) smsFields[id] = { hail_size: f.hail_size, street: f.street, day };
  }
  const emailFields: Record<string, Record<string, string>> = {};
  for (const id of recipients.emailIds) {
    const f = recipients.fields[id];
    if (f) emailFields[id] = { hail_size: f.hail_size, street: f.street };
  }

  const smsPayload = {
    purpose: 'marketing',
    body: settings.smsTemplate ?? DEFAULT_STORM_SMS,
    customerIds: recipients.smsIds,
    fields: smsFields,
    dedupePrefix,
  };
  let smsOff: string | undefined;
  if (facts.campaignStatus !== 'approved') smsOff = STORM_OFF.textingNotApproved;
  else if (recipients.smsIds.length === 0) smsOff = STORM_OFF.noSmsRecipients;
  else smsOff = stepTypes.send_sms_batch.validate?.(smsPayload as never, { companyName: facts.company.name }) ?? undefined;

  const emailBody = settings.emailTemplate ?? DEFAULT_STORM_EMAIL_BODY;
  const emailPayload = {
    purpose: 'marketing',
    subject: settings.emailSubject ?? DEFAULT_STORM_EMAIL_SUBJECT,
    body: emailBody,
    customerIds: recipients.emailIds,
    fields: emailFields,
    dedupePrefix,
    companyStormId,
  };
  let emailOff: string | undefined;
  if (!settings.emailEnabled) emailOff = STORM_OFF.emailsOff;
  else if (facts.company.address === null) emailOff = STORM_OFF.noAddress;
  else if (recipients.emailIds.length === 0) emailOff = STORM_OFF.noEmailRecipients;
  else if (missingStormTokens(emailBody, 'email').length > 0) emailOff = EMAIL_INCOMPLETE;

  const routesPayload = { companyStormId, repUserIds: facts.repUserIds, maxDoors: MAX_DOORS };
  let routesOff: string | undefined;
  if (facts.homesHit === 0) routesOff = STORM_OFF.noHomes;
  else if (facts.repUserIds.length === 0) routesOff = STORM_OFF.noReps;

  const split = splitAdBudget(settings.adBudgetCents, settings.adGoogleSharePct);
  const copy = adCopy(facts);
  const googlePayload = {
    companyStormId,
    platform: 'google',
    maxSpendCents: split.google,
    days: settings.adDays,
    headline: copy.headline,
    description: copy.description,
    keywords: GOOGLE_KEYWORDS,
  };
  let googleOff: string | undefined;
  if (!facts.adActive.google) googleOff = STORM_OFF.noGoogle;
  else if (split.google < MIN_AD_CENTS) googleOff = STORM_OFF.googleBudgetSmall;

  const metaPayload = {
    companyStormId,
    platform: 'meta',
    maxSpendCents: split.meta,
    days: settings.adDays,
    headline: copy.headline,
    description: copy.description,
    primaryText: copy.primaryText,
    photoId: facts.newestPhotoId,
  };
  let metaOff: string | undefined;
  if (!facts.adActive.meta) metaOff = STORM_OFF.noMeta;
  else if (split.meta < MIN_AD_CENTS) metaOff = STORM_OFF.metaBudgetSmall;

  const step = (type: Step['type'], payload: unknown, off: string | undefined): Step =>
    off === undefined ? { type, payload } : { type, payload, off };
  return [
    step('send_sms_batch', smsPayload, smsOff),
    step('send_email_batch', emailPayload, emailOff),
    step('build_routes', routesPayload, routesOff),
    step('create_ad_campaign', googlePayload, googleOff),
    step('create_ad_campaign', metaPayload, metaOff),
  ];
}

/**
 * Drafts (or re-drafts) the storm's plan and returns its task; null when Storm Scout is paused (nothing is drafted).
 * Ruling BD: for every caller an old plan in draft, expired or declined is re-drafted; any other status is returned unchanged.
 * opts.rerunOfTaskId, opts.createdByUserId and opts.afterCreate (A1 T20 rerun): the rerun link, the acting member (the 'created'
 * event actor is that user) and the caller's audit commit with the draft in this one transaction, so a unique violation on
 * agent_tasks_company_rerun_of_uniq rolls the whole re-draft back. Default storm drafting stays actor 'agent'.
 */
export async function draftStormPlan(
  deps: AppDeps,
  companyId: string,
  companyStormId: string,
  now: Date,
  opts: { rerunOfTaskId?: string; createdByUserId?: string; afterCreate?: (tx: Tx, taskId: string) => Promise<void> } = {},
): Promise<{ taskId: string } | null> {
  const ctx = systemContext(companyId);
  const drafted = await withTenant(deps.pools, ctx, async (tx) => {
    // A1 T14 (Ruling AX-K): a paused Storm Scout drafts no new plan (the storm alerts still go out).
    if (await isAgentPaused(tx, ctx, 'storm_scout')) return null;
    const facts = await loadStormPlanFacts(tx, ctx, companyStormId);
    if (!facts) throw new Error(STORM_PLAN_ERRORS.notFound);
    if (facts.status === 'dismissed') throw new Error(STORM_PLAN_ERRORS.dismissed);
    const replaceable = facts.planStatus === 'draft' || facts.planStatus === 'expired' || facts.planStatus === 'declined';
    if (facts.planTaskId !== null && !replaceable) return { taskId: facts.planTaskId, fresh: false };

    const recipients = await listStormPlanRecipients(tx, ctx, companyStormId);
    const day = stormDayLabel(facts.convectiveDay, now, facts.company.timezone);
    const steps = buildSteps(facts, recipients, companyStormId, day);
    const summary = `${facts.customersHit} of your customers and ${facts.homesHit} homes were hit by radar-estimated hail up to ${hailLabel(facts.maxIn)}.`;
    const { taskId } = await createTask(
      tx,
      ctx,
      {
        agent: 'storm_scout',
        kind: 'storm_plan',
        title: stormTitle(facts.placeName, facts.maxIn),
        summary,
        subjectType: 'company_storm',
        subjectId: companyStormId,
        expiresAt: new Date(now.getTime() + PLAN_LIFETIME_MS),
        steps,
        ...(opts.rerunOfTaskId !== undefined && {
          rerunOfTaskId: opts.rerunOfTaskId,
          createdBy: 'user' as const,
          ...(opts.createdByUserId !== undefined && { createdByUserId: opts.createdByUserId }),
        }),
      },
      { now },
    );
    const lock = await lockStormPlan(tx, ctx, companyStormId);
    if (!lock.ok) throw new Error(STORM_PLAN_ERRORS.changed);
    if (lock.oldDraftId !== null && !(await supersedeDraft(tx, ctx, lock.oldDraftId, taskId, now))) throw new Error(STORM_PLAN_ERRORS.changed);
    await linkStormPlan(tx, ctx, companyStormId, taskId, now);
    if (opts.afterCreate) await opts.afterCreate(tx, taskId);
    return { taskId, fresh: true };
  });

  if (drafted === null) return null;
  // After the commit, so the owner is never told about a plan that was rolled back.
  if (drafted.fresh) await alertPlanReady(deps, companyId, companyStormId, drafted.taskId);
  return { taskId: drafted.taskId };
}
