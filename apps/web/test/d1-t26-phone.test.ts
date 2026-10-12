// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatPhone } from '../src/lib/phone.ts';

describe('formatPhone', () => {
  it('formats a US number', () => {
    expect(formatPhone('+15551230001')).toBe('(555) 123-0001');
    expect(formatPhone('15551230001')).toBe('(555) 123-0001');
  });

  it('returns other numbers unchanged', () => {
    expect(formatPhone('+442071234567')).toBe('+442071234567');
  });

  it('is no longer defined in ConversationRow', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/features/front-desk/ConversationRow.tsx', import.meta.url)), 'utf8');
    expect(source).not.toContain('export function formatPhone');
  });
});
