import { Router } from 'express';
import { z } from 'zod';
import { getFrontDeskSettings, saveFrontDeskSettings, withTenant } from '@roofline/db';
import {
  FRONT_DESK_LIMITS,
  FRONT_DESK_VOICES,
  type FrontDeskSettings,
  type FrontDeskSettingsInput,
  type FrontDeskVoice,
} from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { readOnCallRows, writeOnCallOrder } from '../account/transfer-phone.ts';
import { forwardingTestRoutes } from '../front-desk/forwarding-test.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { ensureVoiceUrl } from '../jobs/scheduler/fd-health.ts';
import { parse, UUID } from '../validate.ts';
import { frontDeskStatsRoutes } from './front-desk-stats.ts';

const NOT_BUILT = 'This part of Front Desk is not built yet.';
const NEEDS_NUMBER = 'Front Desk needs a business phone number first. Add one in Settings.';
const NEEDS_FORWARDING = 'Test call forwarding first. Only the owner can turn Front Desk on without it.';
const BAD_MEMBER = 'Pick people who are on your team.';
const BAD_VOICE = 'Pick one of the voices.';
const FACTS_TOO_LONG = `Keep this to ${FRONT_DESK_LIMITS.factsMaxChars} characters or fewer.`;

const L = FRONT_DESK_LIMITS;
const whole = (min: number, max: number) => {
  const message = `Use a whole number from ${min} to ${max}.`;
  return z.number({ error: message }).int(message).min(min, message).max(max, message);
};
const flag = z.boolean({ error: MESSAGES.checkField });

const SettingsBody = z.object({
  enabled: flag,
  texts: flag,
  voice: z.enum(FRONT_DESK_VOICES.map((v) => v.id) as [string, ...string[]], { error: BAD_VOICE }),
  facts: z
    .string({ error: MESSAGES.checkField })
    .max(L.factsMaxChars, FACTS_TOO_LONG)
    .refine((v) => !v.includes('\0'), MESSAGES.checkField),
  canMove: flag,
  canCancel: flag,
  ringTeamFirstSeconds: whole(L.ringTeamFirstSeconds.min, L.ringTeamFirstSeconds.max),
  missedCallTextBack: flag,
  recordingRetentionDays: whole(L.recordingRetentionDays.min, L.recordingRetentionDays.max),
  transcriptRetentionDays: whole(L.transcriptRetentionDays.min, L.transcriptRetentionDays.max),
  maxConcurrentAiCalls: whole(L.maxConcurrentAiCalls.min, L.maxConcurrentAiCalls.max),
  onCallOrder: z.array(z.string({ error: BAD_MEMBER }).regex(UUID, BAD_MEMBER), { error: BAD_MEMBER }).max(200, BAD_MEMBER),
  override: z.boolean({ error: MESSAGES.checkField }).optional(),
});

/** Owner and office manage Front Desk settings. */
const canManage = (role: string): boolean => role === 'owner' || role === 'office';

/**
 * `/api/front-desk`:
 * - `GET /settings`, `PUT /settings` (owner, office): FrontDeskSettings / FrontDeskSettingsInput (+ `override`).
 *   Turning Front Desk on needs a voice number and a passed forwarding test; only the owner may send
 *   `override: true` to skip the test. The save that turns it on sets the number's voice URL.
 * - `GET /voices` (any role): the four voices.
 * - `/forwarding-test` and `/stats` are mounted below. Anything not built yet answers 501.
 */
export function frontDeskRoutes(deps: AppDeps): Router {
  const { pools } = deps;
  const router = Router();
  router.use('/forwarding-test', forwardingTestRoutes(deps));
  router.use('/stats', frontDeskStatsRoutes(deps));

  const settingsView = async (ctx: Express.Request['ctx']): Promise<FrontDeskSettings> => {
    const row = await withTenant(pools, ctx, (tx) => getFrontDeskSettings(tx, ctx));
    const members = await readOnCallRows(deps, ctx);
    const { hasVoiceNumber, forwardingVerifiedAt, ...columns } = row;
    return {
      ...columns,
      blockedReason: !hasVoiceNumber ? 'no_number' : forwardingVerifiedAt === null ? 'forwarding_not_verified' : null,
      forwardingVerifiedAt: forwardingVerifiedAt ? forwardingVerifiedAt.toISOString() : null,
      onCall: members.map((m) => ({
        userId: m.userId,
        name: m.name,
        onCallOrder: m.onCallOrder,
        transferPhoneE164: m.transferPhoneE164,
        recordingAcknowledged: m.recordingAckAt !== null,
      })),
    };
  };

  router.get('/settings', async (req, res) => {
    if (!canManage(req.ctx.role)) throw new AppError(403, MESSAGES.roleCannot);
    res.json(await settingsView(req.ctx));
  });

  router.put('/settings', async (req, res) => {
    const { ctx } = req;
    if (!canManage(ctx.role)) throw new AppError(403, MESSAGES.roleCannot);
    const { override, onCallOrder, ...rest } = parse(SettingsBody, req.body);
    const input = { ...rest, onCallOrder } as FrontDeskSettingsInput;

    const members = await readOnCallRows(deps, ctx);
    const known = new Set(members.map((m) => m.userId));
    const ids = onCallOrder.map((id) => id.toLowerCase());
    if (ids.some((id) => !known.has(id)) || new Set(ids).size !== ids.length) throw new AppError(400, BAD_MEMBER, 'onCallOrder');

    await withTenant(pools, ctx, async (tx) => {
      const current = await getFrontDeskSettings(tx, ctx);
      // Only the switch from off to on is checked, so an owner's earlier override is not undone by a later edit.
      if (input.enabled && !current.enabled) {
        if (!current.hasVoiceNumber) throw new AppError(409, NEEDS_NUMBER, 'enabled');
        if (current.forwardingVerifiedAt === null && !(override === true && ctx.role === 'owner')) {
          throw new AppError(409, NEEDS_FORWARDING, 'enabled');
        }
      }
      await saveFrontDeskSettings(tx, ctx, input);
    });
    await writeOnCallOrder(deps, ctx, ids);

    // Ruling DE: every save makes sure the number has its voice URL; numbers that already have it are skipped.
    try {
      await ensureVoiceUrl(deps, ctx.companyId);
    } catch {
      console.error(`Front Desk: setting the voice URL failed for company ${ctx.companyId}.`);
    }
    res.json(await settingsView(ctx));
  });

  router.get('/voices', (_req, res) => {
    const voices: FrontDeskVoice[] = FRONT_DESK_VOICES.map((v) => ({ id: v.id, label: v.label, previewUrl: null }));
    res.json(voices);
  });

  router.all('/', (_req, res) => {
    res.status(501).json({ error: NOT_BUILT });
  });
  router.all('/{*rest}', (_req, res) => {
    res.status(501).json({ error: NOT_BUILT });
  });
  return router;
}
