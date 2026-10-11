import { readFileSync } from 'node:fs';
import { type BillingConfig, BillingConfigError, parseBillingConfig } from '@roofline/shared';
import type { AppDeps } from '../app.ts';

/** The parsed plans file, once per path: a file is read the first time and then kept for the process. */
const loaded = new Map<string, BillingConfig>();

/**
 * The billing plans (config/billing-plans*.json) that `BILLING_PLANS_FILE` names, parsed and checked
 * by `parseBillingConfig`. A missing setting, a missing or unreadable file throws its own error; a
 * file that is not valid JSON or not a valid plans file throws `BillingConfigError`.
 */
export function billingConfig(deps: AppDeps): BillingConfig {
  const path = deps.config.BILLING_PLANS_FILE;
  if (!path) throw new Error('BILLING_PLANS_FILE is not set');
  const known = loaded.get(path);
  if (known !== undefined) return known;
  const text = readFileSync(path, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BillingConfigError(`${path} is not valid JSON.`);
  }
  const config = parseBillingConfig(json);
  loaded.set(path, config);
  return config;
}
