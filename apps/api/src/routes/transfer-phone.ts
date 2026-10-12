import { Router } from 'express';
import { z } from 'zod';
import type { TransferPhoneView } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { readTransferPhone, writeTransferPhone } from '../account/transfer-phone.ts';
import { parse } from '../validate.ts';

const NOT_BUILT = 'This part of Front Desk (the transfer phone) is not built yet.';
const E164_MESSAGE = 'Enter the phone number with its country code, like +14025550123.';
const ACK_MESSAGE = 'Please confirm that calls to this phone may be recorded.';

const Body = z.object({
  e164: z.string({ error: E164_MESSAGE }).regex(/^\+[1-9]\d{7,14}$/, E164_MESSAGE),
  ackRecording: z.literal(true, { error: ACK_MESSAGE }),
});

/**
 * `/api/me/transfer-phone`: the number a live call is handed to for the signed-in person, any role.
 * - `GET /` answers `{ e164, prefill, recordingAcknowledgedAt }`; `prefill` is the phone on their account.
 * - `PUT /` takes `{ e164, ackRecording: true }`. Only the caller's own membership changes.
 */
export function transferPhoneRoutes(deps: AppDeps): Router {
  const router = Router();

  const view = (p: Awaited<ReturnType<typeof readTransferPhone>>): TransferPhoneView => ({
    e164: p.e164,
    prefill: p.prefill,
    recordingAcknowledgedAt: p.recordingAckAt ? p.recordingAckAt.toISOString() : null,
  });

  router.get('/', async (req, res) => {
    res.json(view(await readTransferPhone(deps, req.ctx)));
  });

  router.put('/', async (req, res) => {
    const body = parse(Body, req.body);
    res.json(view(await writeTransferPhone(deps, req.ctx, body.e164)));
  });

  router.all('/{*rest}', (_req, res) => {
    res.status(501).json({ error: NOT_BUILT });
  });
  return router;
}
