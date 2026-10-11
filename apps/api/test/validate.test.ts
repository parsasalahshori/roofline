import { describe, expect, expectTypeOf, test } from 'vitest';
import { z } from 'zod';
import { AppError } from '../src/errors.ts';
import { parse } from '../src/validate.ts';

const FALLBACK = 'Please check this field.';

function failure(schema: z.ZodType, value: unknown): AppError {
  try {
    parse(schema, value);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error('Expected parse() to throw');
}

describe('parse', () => {
  test('returns the parsed value, including transforms', () => {
    const Email = z.object({ email: z.string().trim().toLowerCase() });
    const parsed = parse(Email, { email: '  Owner@A.TEST ' });
    expect(parsed).toEqual({ email: 'owner@a.test' });
    expectTypeOf(parsed).toEqualTypeOf<{ email: string }>();
  });

  test('throws a 400 AppError', () => {
    const err = failure(z.object({ name: z.string() }), {});
    expect(err.status).toBe(400);
  });

  test('uses the schema’s own message when it has one', () => {
    const err = failure(z.object({ password: z.string().min(10, 'Use at least 10 characters.') }), {
      password: 'short',
    });
    expect(err.message).toBe('Use at least 10 characters.');
    expect(err.field).toBe('password');
  });

  test.each([
    ['z.string({ error })', z.object({ name: z.string({ error: 'Tell us your name.' }) }), {}, 'Tell us your name.'],
    [
      'refine',
      z.object({ a: z.string(), b: z.string() }).refine((v) => v.a === v.b, 'The two values must match.'),
      { a: 'x', b: 'y' },
      'The two values must match.',
    ],
    [
      'superRefine',
      z.object({ n: z.number() }).superRefine((v, ctx) => {
        if (v.n < 0) ctx.addIssue({ code: 'custom', message: 'No negatives, please.', path: ['n'] });
      }),
      { n: -1 },
      'No negatives, please.',
    ],
  ])('keeps a custom message from %s', (_name, schema, value, message) => {
    expect(failure(schema, value).message).toBe(message);
  });

  test('falls back to a plain sentence when the schema gave no message', () => {
    const err = failure(z.object({ email: z.email() }), { email: 'nope' });
    expect(err.message).toBe(FALLBACK);
    expect(err.field).toBe('email');
  });

  test('field is the first issue’s path joined with dots', () => {
    const nested = z.object({ address: z.object({ zip: z.string().length(5) }) });
    expect(failure(nested, { address: { zip: '1' } }).field).toBe('address.zip');
    const list = z.object({ items: z.array(z.object({ qty: z.number() })) });
    expect(failure(list, { items: [{ qty: 1 }, { qty: 'x' }] }).field).toBe('items.1.qty');
  });

  test('reports the first issue when several fields are wrong', () => {
    const schema = z.object({ email: z.email(), password: z.string().min(10, 'Too short.') });
    const err = failure(schema, { email: 'nope', password: 'x' });
    expect(err.field).toBe('email');
  });

  test('a failure at the root has no field', () => {
    const err = failure(z.object({ a: z.string() }), 'not an object');
    expect(err.field).toBeUndefined();
    expect(err.message).toBe(FALLBACK);
  });

  test('never surfaces zod’s default English', () => {
    const cases: [z.ZodType, unknown][] = [
      [z.string().min(3), 'x'],
      [z.string().max(2), 'xxxx'],
      [z.number().int(), 1.5],
      [z.number().positive(), -1],
      [z.enum(['owner', 'office', 'rep']), 'admin'],
      [z.object({ a: z.string() }), {}],
      [z.object({ a: z.string() }).strict(), { a: 'x', b: 1 }],
      [z.array(z.string()).min(1), []],
      [z.uuid(), 'abc'],
      [z.iso.datetime(), 'tomorrow'],
      [z.literal('yes'), 'no'],
    ];
    for (const [schema, value] of cases) {
      const err = failure(schema, value);
      expect(err.message).toBe(FALLBACK);
      expect(err.message).not.toMatch(/expected|received|Too small|Too big|Invalid/);
    }
  });
});
