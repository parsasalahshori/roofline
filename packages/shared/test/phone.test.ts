import { expect, test } from 'vitest';
import { toE164 } from '../src/phone.ts';

test.each(['(402) 555-0144', '402.555.0144', '+1 402 555 0144', '4025550144'])('%s → +14025550144', (s) => {
  expect(toE164(s)).toBe('+14025550144');
});
test.each(['555-0144', '', 'call me', '+1 000 000 0000'])('%s → null', (s) => expect(toE164(s)).toBeNull());
