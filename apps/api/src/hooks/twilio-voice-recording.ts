import express, { Router } from 'express';
import { companyIdForCallSid } from '@roofline/db/system';
import { findCallRecordingBySid, setCallRecording, type TenantContext, withTenant } from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { checkSignature, field, FORM_BODY_LIMIT } from './twilio.ts';

/**
 * POST /hooks/twilio/voice/recording: Twilio's recordingStatusCallback. Only a completed recording
 * is acted on: its length is saved and the fd-recording-store job copies it to file storage.
 * The company is found from CallSid, because Twilio's recording callback has no To or From.
 * Always answers 204 once the request is accepted.
 */
export function twilioVoiceRecordingHooks(deps: AppDeps): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false, limit: FORM_BODY_LIMIT }));

  router.post('/', async (req, res) => {
    const callSid = field(req, 'CallSid');
    if (callSid === undefined || callSid === '') {
      res.status(400).end();
      return;
    }
    const companyId = await companyIdForCallSid(deps.pools.system, callSid);
    if (companyId === null) {
      res.status(404).end();
      return;
    }
    if ((await checkSignature(deps, req, res, companyId)) === null) return;
    const recordingSid = field(req, 'RecordingSid');
    if (recordingSid === undefined || recordingSid === '') {
      res.status(400).end();
      return;
    }
    if (field(req, 'RecordingStatus') !== 'completed') {
      res.status(204).end();
      return;
    }
    const ctx: TenantContext = { companyId: companyId, role: 'system', userId: null, canApproveSpend: false };
    const seconds = Number.parseInt(field(req, 'RecordingDuration') ?? '', 10);
    const call = await withTenant(deps.pools, ctx, async (tx) => {
      const found = await findCallRecordingBySid(tx, ctx, callSid);
      if (found !== null && Number.isFinite(seconds)) await setCallRecording(tx, ctx, callSid, { recordingSeconds: seconds });
      return found;
    });
    if (call === null) {
      res.status(204).end();
      return;
    }
    await deps.jobs.send(
      'fd-recording-store',
      { companyId: companyId, callId: call.id, recordingSid },
      { singletonKey: `fd-recording-store:${recordingSid}` },
    );
    res.status(204).end();
  });

  return router;
}
