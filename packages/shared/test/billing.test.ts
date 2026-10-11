import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, test } from 'vitest';
import {
  BillingConfigError,
  invoiceAmountCents,
  meterUnits,
  meteredTiers,
  parseBillingConfig,
  planByKey,
  planFromLookupKey,
  priceLookupKeys,
} from '../src/billing.ts';

const EXAMPLE = fileURLToPath(new URL('../../../config/billing-plans.example.json', import.meta.url));
const load = () => JSON.parse(readFileSync(EXAMPLE, 'utf8'));

describe('billing config and metering', () => {
  const cfg = parseBillingConfig(load());

  test('example config parses and metering math matches the spec', () => {
    expect(cfg.plans.map((p) => p.key)).toEqual(['starter', 'pro']);
    expect(meterUnits('mms', 1)).toEqual({ meter: 'sms_segment', value: 3 });
    expect(meterUnits('sms_segment', 2)).toEqual({ meter: 'sms_segment', value: 2 });
    expect(meterUnits('ai_call_minute', 2.2)).toEqual({ meter: 'ai_call_minute', value: 3 });
    expect(meterUnits('exact_report', 1)).toBeNull();
    expect(invoiceAmountCents('exact_report', 1, 4500, cfg)).toBe(5400);
    expect(invoiceAmountCents('texting_registration_fee', 1, 4400, cfg)).toBe(4400);
    expect(invoiceAmountCents('phone_number_month', 1, 115, cfg)).toBe(115);
    expect(() => invoiceAmountCents('sms_segment', 1, 1, cfg)).toThrow(RangeError);
    expect(meteredTiers(planByKey(cfg, 'starter')!, 'sms_segment')).toEqual([
      { up_to: 1000, unit_amount_decimal: '0' },
      { up_to: 'inf', unit_amount_decimal: '3' },
    ]);
    expect(priceLookupKeys('pro').monthly).toBe('roofline_pro_monthly');
    expect(planFromLookupKey('roofline_pro_sms_segment')).toBe('pro');
  });

  it('returns a single paid tier when the included amount is zero', () => {
    const starter = planByKey(cfg, 'starter')!;
    const free = { ...starter, included: { ...starter.included, sms_segments: 0 } };
    expect(meteredTiers(free, 'sms_segment')).toEqual([{ up_to: 'inf', unit_amount_decimal: '3' }]);
  });

  it('returns null for unknown plan keys and foreign lookup keys', () => {
    expect(planByKey(cfg, 'nope')).toBeNull();
    expect(planFromLookupKey('other_pro_monthly')).toBeNull();
  });

  it('refuses bad config with the path', () => {
    const dupKey = load();
    dupKey.plans[1].key = 'starter';
    const negPrice = load();
    negPrice.plans[0].monthly_price_cents = -1;
    const noIncluded = load();
    delete noIncluded.plans[0].included;

    const cases: [unknown, string][] = [
      [dupKey, 'plans.1.key'],
      [negPrice, 'plans.0.monthly_price_cents'],
      [noIncluded, 'plans.0.included'],
    ];
    for (const [bad, path] of cases) {
      let caught: unknown = null;
      try {
        parseBillingConfig(bad);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BillingConfigError);
      expect((caught as Error).message).toContain(path);
    }
  });

  it('refuses unknown top-level keys and accepts _note', () => {
    expect(() => parseBillingConfig({ ...load(), extra: 1 })).toThrow(BillingConfigError);
    const { _note, ...withoutNote } = load();
    expect(_note).toEqual(expect.any(String));
    expect(() => parseBillingConfig(withoutNote)).not.toThrow();
    expect(() => parseBillingConfig({ ...withoutNote, _note })).not.toThrow();
    expect(parseBillingConfig(load()).plans.length).toBe(2);
  });

  it('the code has no hard-coded prices', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const forbidden = ['19900', '39900'];
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules') continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        const text = readFileSync(full, 'utf8');
        if (forbidden.some((n) => text.includes(n))) offenders.push(full);
      }
    };

    for (const group of ['apps', 'packages']) {
      const groupDir = join(root, group);
      let entries: string[];
      try {
        entries = readdirSync(groupDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const src = join(groupDir, entry, 'src');
        try {
          if (statSync(src).isDirectory()) walk(src);
        } catch {
          // no src folder for this package
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
