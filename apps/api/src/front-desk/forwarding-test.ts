import { Router, type RequestHandler } from 'express';
import {
  companyContact,
  countForwardingTestsSince,
  createForwardingTestCall,
  failForwardingTest,
  findPendingForwardingTest,
  getForwardingTest,
  type ForwardingTestRecord,
  lockForwardingTests,
  markForwardingVerified,
  recentForwardingTestAt,
  withTenant,
} from '@roofline/db';
import { textability, type ForwardingTestView } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { isRooflineNumber } from '../account/transfer-phone.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { systemContext } from '../permissions.ts';

/*
 * The forwarding test (D1 Task 17). POST /api/front-desk/forwarding-test places a call from Roofline's
 * test caller number to the company's business number; the business line forwards it to the Roofline
 * number, where the voice hook recognises it and marks the test verified. GET reads the result. A test
 * still ringing after 30 s is failed by the 'fd-forwarding-test' job. Only owner and office may use it.
 * Logs nothing here: no phone numbers, and call ids only where a job needs one.
 */

const PHONE_FIRST = 'Add your business phone number in Settings → Company first.';
const UNSUPPORTED_PHONE = 'The forwarding test only works with a US business phone number. Check the number in Settings → Company.';
const TEST_CALLER_UNSET = "The forwarding test isn't available right now. Try again later.";
const PLACE_FAILED = "We couldn't place the test call. Try again in a minute.";
const WAIT = 'Wait a minute before testing again.';
const ROOFLINE_PHONE = 'The business phone in Settings → Company is a Roofline number. Enter the phone line your customers call.';
const DAILY_LIMIT_REACHED = "You've run the forwarding test 10 times in the last day. Try again tomorrow.";
/** At most this many test calls per company in any rolling 24 hours (pre-review #26). */
export const FORWARDING_TESTS_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_SECONDS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only the owner and the office role may run the forwarding test (the spec's Front Desk setup rule). */
const ownerOrOffice: RequestHandler = (req, _res, next) => {
  const ctx = req.ctx as typeof req.ctx | undefined;
  const allowed = ctx?.role === 'owner' || ctx?.role === 'office';
  next(allowed ? undefined : new AppError(403, MESSAGES.roleCannot));
};

/** The Ruling DR view: 'calling' until the call arrives (verified) or the 30 s timeout ends it (not_received). */
function viewOf(row: ForwardingTestRecord): ForwardingTestView {
  const base = { id: row.id, startedAt: row.startedAt.toISOString(), finishedAt: row.endedAt ? row.endedAt.toISOString() : null };
  if (row.verified) return { ...base, status: 'verified' };
  if (row.status === 'ringing') return { ...base, status: 'calling' };
  return { ...base, status: 'not_received' };
}

export function forwardingTestRoutes(deps: AppDeps): Router {
  const { pools, config, clock, callControl, jobs } = deps;
  const router = Router();

  router.post('/', ownerOrOffice, async (req, res) => {
    const { ctx } = req;
    const testCaller = config.TWILIO_TEST_CALLER_NUMBER;
    const now = clock.now();

    const businessPhone = await withTenant(pools, ctx, async (tx) => (await companyContact(tx, ctx))?.phoneE164 ?? null);
    if (!businessPhone) throw new AppError(422, PHONE_FIRST, 'phone');
    const kind = textability(businessPhone);
    if (kind === 'toll_free' || kind === 'not_us') throw new AppError(422, UNSUPPORTED_PHONE, 'phone');
    if (await isRooflineNumber(deps, businessPhone)) throw new AppError(422, ROOFLINE_PHONE, 'phone');
    if (testCaller === undefined) throw new AppError(503, TEST_CALLER_UNSET);

    const id = await withTenant(pools, ctx, async (tx) => {
      await lockForwardingTests(tx, ctx);
      if (await recentForwardingTestAt(tx, ctx, testCaller, new Date(now.getTime() - 60 * 1000))) {
        throw new AppError(429, WAIT);
      }
      if ((await countForwardingTestsSince(tx, ctx, testCaller, new Date(now.getTime() - DAY_MS))) >= FORWARDING_TESTS_PER_DAY) {
        throw new AppError(429, DAILY_LIMIT_REACHED);
      }
      let placed: { callSid: string };
      try {
        placed = await callControl.placeTestCall({
          to: businessPhone,
          from: testCaller,
          statusCallback: `${config.PUBLIC_BASE_URL}/hooks/twilio/voice-status`,
        });
      } catch {
        throw new AppError(503, PLACE_FAILED);
      }
      const row = await createForwardingTestCall(tx, ctx, { callSid: placed.callSid, fromE164: testCaller, toE164: businessPhone, now });
      return row.id;
    });

    await jobs.send('fd-forwarding-test', { companyId: ctx.companyId, testId: id }, { startAfter: TIMEOUT_SECONDS, singletonKey: id });
    res.status(200).json({ id });
  });

  router.get('/:id', ownerOrOffice, async (req, res) => {
    const { ctx } = req;
    const testCaller = config.TWILIO_TEST_CALLER_NUMBER;
    const id = req.params.id;
    if (testCaller === undefined || typeof id !== 'string' || !UUID.test(id)) throw new AppError(404, MESSAGES.notFound);

    const row = await withTenant(pools, ctx, (tx) => getForwardingTest(tx, ctx, id, testCaller));
    if (!row) throw new AppError(404, MESSAGES.notFound);
    res.json(viewOf(row));
  });

  return router;
}

/**
 * The 30 s timeout (the 'fd-forwarding-test' job): a test still ringing is failed. A test that arrived
 * or ended is left alone.
 */
export async function expireForwardingTest(deps: AppDeps, companyId: string, testId: string): Promise<void> {
  const ctx = systemContext(companyId);
  await withTenant(deps.pools, ctx, (tx) => failForwardingTest(tx, ctx, testId, deps.clock.now()));
}

/**
 * The voice hook's test-call branch. A call from the test caller number, to a company that has a
 * pending test, is the proof that forwarding works: the test ends and the company is marked verified.
 * Returns true when it did, so the hook answers with the test TwiML and nothing else. Any other call
 * returns false.
 */
export type ForwardingArrival = { forwardedFrom?: string | null; stirVerstat?: string | null };

export async function forwardingTestArrived(
  deps: AppDeps,
  companyId: string,
  fromE164: string,
  arrival: ForwardingArrival = {},
): Promise<boolean> {
  const testCaller = deps.config.TWILIO_TEST_CALLER_NUMBER;
  if (testCaller === undefined || fromE164 !== testCaller) return false;
  const ctx = systemContext(companyId);
  const now = deps.clock.now();
  return withTenant(deps.pools, ctx, async (tx) => {
    // A caller id alone can be spoofed: the call must also show it was forwarded from the business line
    // (the signed ForwardedFrom) or carry a passing STIR/SHAKEN verdict.
    const businessPhone = (await companyContact(tx, ctx))?.phoneE164 ?? null;
    const forwarded = businessPhone !== null && arrival.forwardedFrom === businessPhone;
    const attested = typeof arrival.stirVerstat === 'string' && arrival.stirVerstat.startsWith('TN-Validation-Passed');
    if (!forwarded && !attested) return false;
    const pending = await findPendingForwardingTest(tx, ctx, fromE164, now);
    if (!pending) return false;
    await markForwardingVerified(tx, ctx, pending.callSid, now);
    return true;
  });
}
