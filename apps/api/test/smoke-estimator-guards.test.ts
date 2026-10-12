import { describe, expect, test } from 'vitest';
import {
  CONFIRM_PROVIDERS_FLAG,
  assertConfirmedProviders,
  assertEstimatorConfig,
  assertPlaceOrderAllowed,
  maskPhone,
  missingEstimatorConfig,
  parseEstimatorArgs,
  redactSecrets,
  type EstimatorArgs,
} from '../src/scripts/smoke/estimator-guards.ts';
import { SmokeRefused } from '../src/scripts/smoke/guards.ts';

// Pure checks only: the smoke script itself is run by hand, never from the test suite.

const CONFIRM = '--confirm-real-providers';

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

const sandboxArgs: EstimatorArgs = { eagleview: true, r2: false, sms: null, placeOrder: false };

describe('refuses without --confirm-real-providers', () => {
  test('refuses without --confirm-real-providers', () => {
    const err = errorOf(() => assertConfirmedProviders(['--eagleview-sandbox']));
    expect(err).toBeInstanceOf(SmokeRefused);
    expect((err as Error).message).toBe(
      'This calls real providers and can cost money or send a real text. Pass --confirm-real-providers if you mean it.',
    );
  });

  test('accepts the confirm flag', () => {
    expect(CONFIRM_PROVIDERS_FLAG).toBe(CONFIRM);
    expect(() => assertConfirmedProviders([CONFIRM, '--r2'])).not.toThrow();
  });
});

describe('--place-order is refused unless EAGLEVIEW_ENV=sandbox', () => {
  const placeOrder: EstimatorArgs = { ...sandboxArgs, placeOrder: true };

  test('--place-order is refused unless EAGLEVIEW_ENV=sandbox', () => {
    const err = errorOf(() => assertPlaceOrderAllowed(placeOrder, {}));
    expect(err).toBeInstanceOf(SmokeRefused);
    expect((err as Error).message).toBe(
      'PlaceOrder is only allowed against the EagleView sandbox. Set EAGLEVIEW_ENV=sandbox.',
    );
  });

  test('--place-order is refused when EAGLEVIEW_ENV is production', () => {
    expect(() => assertPlaceOrderAllowed(placeOrder, { EAGLEVIEW_ENV: 'production' })).toThrow(SmokeRefused);
  });

  test('--place-order is allowed when EAGLEVIEW_ENV is sandbox', () => {
    expect(() => assertPlaceOrderAllowed(placeOrder, { EAGLEVIEW_ENV: 'sandbox' })).not.toThrow();
  });

  test('a smoke run with the EagleView check refuses production even without --place-order', () => {
    const err = errorOf(() => assertPlaceOrderAllowed(sandboxArgs, { EAGLEVIEW_ENV: 'production' }));
    expect(err).toBeInstanceOf(SmokeRefused);
    expect((err as Error).message).toBe('The smoke run only uses the EagleView sandbox.');
  });

  test('an unset EAGLEVIEW_ENV is fine when --place-order is absent', () => {
    expect(() => assertPlaceOrderAllowed(sandboxArgs, {})).not.toThrow();
  });

  test('production is allowed by the guard when the EagleView check is absent', () => {
    const rOnly: EstimatorArgs = { eagleview: false, r2: true, sms: null, placeOrder: false };
    expect(() => assertPlaceOrderAllowed(rOnly, { EAGLEVIEW_ENV: 'production' })).not.toThrow();
  });
});

describe('--place-order needs --eagleview-sandbox', () => {
  test('--place-order needs --eagleview-sandbox', () => {
    expect(() => parseEstimatorArgs([CONFIRM, '--place-order', '--r2'])).toThrow(SmokeRefused);
    expect(() => parseEstimatorArgs([CONFIRM, '--place-order'])).toThrow(SmokeRefused);
  });

  test('--place-order with --eagleview-sandbox parses', () => {
    expect(parseEstimatorArgs([CONFIRM, '--eagleview-sandbox', '--place-order'])).toEqual({
      eagleview: true,
      r2: false,
      sms: null,
      placeOrder: true,
    });
  });
});

describe('refuses and names the missing keys without printing values', () => {
  test('refuses and names the missing keys without printing values', () => {
    const env = { EAGLEVIEW_CLIENT_ID: 'sekrit-value-123', EAGLEVIEW_PRODUCT_ID: '  ' };
    expect(missingEstimatorConfig(sandboxArgs, env)).toEqual([
      'EAGLEVIEW_CLIENT_SECRET',
      'EAGLEVIEW_PRODUCT_ID',
    ]);
    const err = errorOf(() => assertEstimatorConfig(sandboxArgs, env));
    expect(err).toBeInstanceOf(SmokeRefused);
    const message = (err as Error).message;
    expect(message).toBe('Set these first: EAGLEVIEW_CLIENT_SECRET, EAGLEVIEW_PRODUCT_ID.');
    expect(message).not.toContain('sekrit-value-123');
  });

  test('lists keys for every chosen check in a fixed order with no duplicates', () => {
    const args: EstimatorArgs = { eagleview: true, r2: true, sms: '+14025550123', placeOrder: false };
    expect(missingEstimatorConfig(args, {})).toEqual([
      'EAGLEVIEW_CLIENT_ID',
      'EAGLEVIEW_CLIENT_SECRET',
      'EAGLEVIEW_PRODUCT_ID',
      'R2_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_BUCKET',
      'DATABASE_URL_TENANT',
      'ENCRYPTION_KEY',
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'SMOKE_COMPANY_ID',
      'SMOKE_PROPOSAL_ID',
    ]);
  });

  test('only the keys of the chosen checks are required', () => {
    const r2: EstimatorArgs = { eagleview: false, r2: true, sms: null, placeOrder: false };
    expect(missingEstimatorConfig(r2, {})).toEqual([
      'R2_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_BUCKET',
    ]);
  });

  test('passes when every needed key is set', () => {
    const env = {
      EAGLEVIEW_CLIENT_ID: 'a',
      EAGLEVIEW_CLIENT_SECRET: 'b',
      EAGLEVIEW_PRODUCT_ID: '42',
    };
    expect(missingEstimatorConfig(sandboxArgs, env)).toEqual([]);
    expect(() => assertEstimatorConfig(sandboxArgs, env)).not.toThrow();
  });
});

describe('EAGLEVIEW_PRODUCT_ID of 0 counts as missing', () => {
  test('EAGLEVIEW_PRODUCT_ID of 0 counts as missing', () => {
    const base = { EAGLEVIEW_CLIENT_ID: 'a', EAGLEVIEW_CLIENT_SECRET: 'b' };
    expect(missingEstimatorConfig(sandboxArgs, { ...base, EAGLEVIEW_PRODUCT_ID: '0' })).toEqual([
      'EAGLEVIEW_PRODUCT_ID',
    ]);
    expect(missingEstimatorConfig(sandboxArgs, { ...base, EAGLEVIEW_PRODUCT_ID: 'abc' })).toEqual([
      'EAGLEVIEW_PRODUCT_ID',
    ]);
    expect(missingEstimatorConfig(sandboxArgs, { ...base, EAGLEVIEW_PRODUCT_ID: '12' })).toEqual([]);
  });
});

describe('--sms requires an E.164 number', () => {
  test('--sms requires an E.164 number', () => {
    // '4025550123' is a substring of the example number in the message, so it is only checked for refusal.
    for (const bad of ['4025550123', '+0123', 'abc', '402-555-0123']) {
      const err = errorOf(() => parseEstimatorArgs([CONFIRM, '--sms', bad]));
      expect(err, bad).toBeInstanceOf(SmokeRefused);
      expect((err as Error).message).toBe('The --sms number must be in E.164 form, like +14025550123.');
    }
    for (const bad of ['+0123', 'abc', '402-555-0123']) {
      const err = errorOf(() => parseEstimatorArgs([CONFIRM, '--sms', bad]));
      expect((err as Error).message).not.toContain(bad);
    }
  });

  test('--sms without a value is refused', () => {
    expect(() => parseEstimatorArgs([CONFIRM, '--r2', '--sms'])).toThrow(SmokeRefused);
    expect(() => parseEstimatorArgs([CONFIRM, '--sms', '--r2'])).toThrow(SmokeRefused);
  });

  test('--sms accepts an E.164 number', () => {
    expect(parseEstimatorArgs([CONFIRM, '--sms', '+14025550123'])).toEqual({
      eagleview: false,
      r2: false,
      sms: '+14025550123',
      placeOrder: false,
    });
  });
});

describe('refuses unknown flags and no check selected', () => {
  test('refuses unknown flags and no check selected', () => {
    const usageErr = errorOf(() => parseEstimatorArgs([CONFIRM, '--r2', '--bogus']));
    expect(usageErr).toBeInstanceOf(SmokeRefused);
    expect((usageErr as Error).message).toContain('Usage');
    expect((usageErr as Error).message).not.toContain('--bogus');

    expect(() => parseEstimatorArgs([CONFIRM, '--r2', '--r2'])).toThrow(SmokeRefused);
    expect(() => parseEstimatorArgs([CONFIRM, '+14025550123'])).toThrow(SmokeRefused);

    const noCheck = errorOf(() => parseEstimatorArgs([CONFIRM]));
    expect(noCheck).toBeInstanceOf(SmokeRefused);
    expect((noCheck as Error).message).toBe(
      'Pick at least one check: --eagleview-sandbox, --r2 or --sms <E.164>.',
    );
  });

  test('parses a combined run', () => {
    expect(
      parseEstimatorArgs([CONFIRM, '--eagleview-sandbox', '--r2', '--sms', '+14025550123']),
    ).toEqual({ eagleview: true, r2: true, sms: '+14025550123', placeOrder: false });
  });
});

describe('redactSecrets removes tokens, keys and the link token', () => {
  test('redactSecrets removes tokens, keys and the link token', () => {
    const text =
      'oauth=tok_abc123xyz key=sk_live_987654 link=https://app.example/p/LINKTOKEN123 again tok_abc123xyz';
    const out = redactSecrets(text, ['tok_abc123xyz', 'sk_live_987654', 'LINKTOKEN123', undefined, '']);
    expect(out).not.toContain('tok_abc123xyz');
    expect(out).not.toContain('sk_live_987654');
    expect(out).not.toContain('LINKTOKEN123');
    expect(out).toContain('[hidden]');
  });

  test('skips secrets shorter than 4 characters', () => {
    expect(redactSecrets('ab cd', ['ab'])).toBe('ab cd');
  });

  test('replaces the longest secret first when one contains another', () => {
    expect(redactSecrets('secret-long-value', ['secret', 'secret-long-value'])).toBe('[hidden]');
  });
});

describe('maskPhone hides the middle digits', () => {
  test('maskPhone hides the middle digits', () => {
    expect(maskPhone('+14025550123')).toBe('+1402***0123');
    expect(maskPhone('+1402')).toBe('***');
  });
});
