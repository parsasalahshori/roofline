import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { DEFAULT_FRONT_DESK_VOICE, type FrontDeskSettingsInput, type FrontDeskVoiceId } from '@roofline/shared';
import { companies, companyPhoneNumbers, companySettings } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/** The Front Desk columns of company_settings, plus what the settings screen needs to say why it is blocked. */
export type FrontDeskSettingsRow = Omit<FrontDeskSettingsInput, 'onCallOrder'> & {
  forwardingVerifiedAt: Date | null;
  /** True when the company has an active number that can take voice calls. */
  hasVoiceNumber: boolean;
};

const DEFAULTS: Omit<FrontDeskSettingsRow, 'hasVoiceNumber'> = {
  enabled: false,
  texts: true,
  voice: DEFAULT_FRONT_DESK_VOICE,
  facts: '',
  canMove: true,
  canCancel: true,
  ringTeamFirstSeconds: 0,
  missedCallTextBack: true,
  recordingRetentionDays: 90,
  transcriptRetentionDays: 365,
  maxConcurrentAiCalls: 4,
  forwardingVerifiedAt: null,
};

async function hasVoiceNumber(tx: Tx, ctx: TenantContext): Promise<boolean> {
  const [row] = await tx
    .select({ id: companyPhoneNumbers.id })
    .from(companyPhoneNumbers)
    .where(
      and(
        eq(companyPhoneNumbers.companyId, ctx.companyId),
        eq(companyPhoneNumbers.status, 'active'),
        sql`${'voice'} = any(${companyPhoneNumbers.capabilities})`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** The company's Front Desk settings (column defaults when it has no settings row yet). */
export async function getFrontDeskSettings(tx: Tx, ctx: TenantContext): Promise<FrontDeskSettingsRow> {
  const [row] = await tx
    .select({
      enabled: companySettings.frontDeskEnabled,
      texts: companySettings.frontDeskTexts,
      voice: companySettings.frontDeskVoice,
      facts: companySettings.frontDeskFacts,
      canMove: companySettings.frontDeskCanMove,
      canCancel: companySettings.frontDeskCanCancel,
      ringTeamFirstSeconds: companySettings.ringTeamFirstSeconds,
      missedCallTextBack: companySettings.missedCallTextBack,
      recordingRetentionDays: companySettings.recordingRetentionDays,
      transcriptRetentionDays: companySettings.transcriptRetentionDays,
      maxConcurrentAiCalls: companySettings.maxConcurrentAiCalls,
      forwardingVerifiedAt: companySettings.forwardingVerifiedAt,
    })
    .from(companySettings)
    .where(eq(companySettings.companyId, ctx.companyId))
    .limit(1);
  const base = row ? { ...row, voice: row.voice as FrontDeskVoiceId } : DEFAULTS;
  return { ...base, hasVoiceNumber: await hasVoiceNumber(tx, ctx) };
}

/** Upserts the Front Desk columns of company_settings. The route sets the number's voice URL after every save (Ruling DE); ensureVoiceUrl only touches numbers still missing it. */
export async function saveFrontDeskSettings(
  tx: Tx,
  ctx: TenantContext,
  input: FrontDeskSettingsInput,
  now: Date = new Date(),
): Promise<void> {
  const values = {
    frontDeskEnabled: input.enabled,
    frontDeskTexts: input.texts,
    frontDeskVoice: input.voice,
    frontDeskFacts: input.facts,
    frontDeskCanMove: input.canMove,
    frontDeskCanCancel: input.canCancel,
    ringTeamFirstSeconds: input.ringTeamFirstSeconds,
    missedCallTextBack: input.missedCallTextBack,
    recordingRetentionDays: input.recordingRetentionDays,
    transcriptRetentionDays: input.transcriptRetentionDays,
    maxConcurrentAiCalls: input.maxConcurrentAiCalls,
  };
  await tx
    .insert(companySettings)
    .values({ companyId: ctx.companyId, ...values })
    .onConflictDoUpdate({ target: companySettings.companyId, set: { ...values, updatedAt: now } });
}

/** Turns Front Desk off and leaves every other setting as it is (a read-only company may still do this). */
export async function turnFrontDeskOff(tx: Tx, ctx: TenantContext, now: Date): Promise<void> {
  await tx
    .update(companySettings)
    .set({ frontDeskEnabled: false, updatedAt: now })
    .where(eq(companySettings.companyId, ctx.companyId));
}

/** Forgets the forwarding test result: the business phone changed, so the old proof no longer holds. */
export async function clearForwardingVerified(tx: Tx, ctx: TenantContext, now: Date): Promise<void> {
  await tx
    .update(companySettings)
    .set({ forwardingVerifiedAt: null, updatedAt: now })
    .where(and(eq(companySettings.companyId, ctx.companyId), isNotNull(companySettings.forwardingVerifiedAt)));
}

/** True when the company's trial ended or its plan was canceled: Roofline is read-only and Front Desk does no AI work (Ruling BG). */
export async function companyReadOnly(tx: Tx, ctx: TenantContext): Promise<boolean> {
  const [row] = await tx.select({ status: companies.status }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
  return row?.status === 'trial_ended' || row?.status === 'canceled';
}
