import { describe, expect, it } from 'vitest';
import { kitFor, stepKits } from '../src/features/approvals/steps/index.ts';
import type { StepView } from '../src/api/types.ts';

const G1 = ['send_personal_texts', 'build_claim_packet', 'create_appointment', 'move_appointment'] as const;
const OLD = ['send_email_batch', 'build_routes', 'create_ad_campaign'];

describe('the G1 step registry', () => {
  it('lists the four new types with a full kit', () => {
    for (const type of G1) {
      const kit = kitFor({ type });
      expect(kit, type).toBeTruthy();
      expect(stepKits[type]).toBe(kit);
      expect(kit?.Preview).toBeTruthy();
      for (const fn of ['review', 'editFields', 'toPayload'] as const) expect(typeof kit?.[fn], `${type}.${fn}`).toBe('function');
    }
  });

  it('still lists the older types', () => {
    for (const type of OLD) expect(Object.keys(stepKits)).toContain(type);
  });

  it('has no edit fields for the claim packet', () => {
    const step = { id: 's', type: 'build_claim_packet', payload: {}, preview: { title: '', lines: [] } } as unknown as StepView;
    expect(kitFor({ type: 'build_claim_packet' })?.editFields(step)).toEqual([]);
  });
});

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (typeof value === 'function') {
    for (const arg of [1, 'x']) {
      try {
        strings((value as (...a: unknown[]) => unknown)(arg, arg, arg), out);
      } catch {
        /* a sample argument the function does not take */
      }
    }
  } else if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value)) strings(inner, out);
  }
  return out;
}

describe('the G1 copy', () => {
  it.each([
    ['stepTexts', () => import('../src/copy/stepTexts.ts')],
    ['stepVisits', () => import('../src/copy/stepVisits.ts')],
    ['stepMoves', () => import('../src/copy/stepMoves.ts')],
  ])('%s has no jargon', async (name, load) => {
    const mod = (await load()) as Record<string, unknown>;
    const found = strings(mod[name]);
    expect(found.length).toBeGreaterThan(0);
    for (const text of found) expect(text, text).not.toMatch(/\b(payload|dedupe|json|api)\b/i);
  });
});
