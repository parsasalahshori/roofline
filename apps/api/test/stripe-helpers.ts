import { createHmac } from 'node:crypto';

/** Shared by the Stripe webhook tests: signs an event body the way Stripe does. */

/**
 * The raw body and the `Stripe-Signature` header for an event, signed with `secret` (the test
 * secret by default) at time `at` (now by default). The header is `t=<unix>,v1=<hex>`, where the
 * hex is HMAC-SHA256 over `${t}.${body}`.
 */
export function signedStripe(event: object, o: { secret?: string; at?: Date } = {}): { body: string; header: string } {
  const secret = o.secret ?? 'whsec_test_roofline';
  const at = o.at ?? new Date();
  const body = JSON.stringify(event);
  const t = Math.floor(at.getTime() / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return { body, header: `t=${t},v1=${v1}` };
}
