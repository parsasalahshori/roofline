// Financing estimate: amortized monthly payment for a principal at an APR.

/**
 * Monthly payment in cents, rounded UP to the cent.
 *
 * @param principalCents amount financed, in cents (0 or less returns 0)
 * @param aprBps annual rate in basis points (999 = 9.99%); 0 means no interest
 * @param months number of monthly payments, a positive integer
 */
export function monthlyPaymentCents(principalCents: number, aprBps: number, months: number): number {
  if (!Number.isInteger(months) || months <= 0 || !Number.isFinite(aprBps) || aprBps < 0 || !Number.isFinite(principalCents)) {
    throw new RangeError('invalid financing inputs');
  }
  if (principalCents <= 0) return 0;
  if (aprBps === 0) return Math.ceil(principalCents / months);
  const r = aprBps / 10000 / 12;
  const payment = (principalCents * r) / (1 - (1 + r) ** -months);
  // The epsilon keeps float noise (e.g. 12345.0000000001) from adding a cent.
  return Math.ceil(payment - 1e-9);
}
