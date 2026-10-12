import { BrandInfoSchema, type BrandInfo } from '@roofline/shared';

/** A smoke run stopped before it touched any provider. The message is safe to print as is. */
export class SmokeRefused extends Error {}

export function assertStripeTestKey(key: string | undefined): string {
  if (key === undefined || !key.startsWith('sk_test_')) {
    throw new SmokeRefused('Use a Stripe test key (sk_test_…) for the smoke run.');
  }
  return key;
}

export function assertConfirmed(argv: readonly string[], flag: '--confirm-real-registration'): void {
  if (!argv.includes(flag)) {
    throw new SmokeRefused(
      'This makes a real registration with the phone carriers and costs money. Pass --confirm-real-registration if you mean it.',
    );
  }
}

/**
 * Parses SMOKE_BRAND_JSON. The error names the fields that failed and never echoes a value or a zod message,
 * so the brand details stay out of the terminal.
 */
export function parseSmokeBrand(json: string | undefined): BrandInfo {
  if (json === undefined || json.trim() === '') {
    throw new SmokeRefused('Set SMOKE_BRAND_JSON to the brand details first.');
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    if (err instanceof SyntaxError) throw new SmokeRefused('SMOKE_BRAND_JSON is not valid JSON.');
    throw err;
  }
  const result = BrandInfoSchema.safeParse(value);
  if (result.success) return result.data;
  const fields = [
    ...new Set(
      result.error.issues.map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : 'the whole value')),
    ),
  ];
  throw new SmokeRefused(`The smoke brand has problems in these fields: ${fields.join(', ')}.`);
}
