import { describe, expect, test } from 'vitest';
import { claimsGuard, DEFAULT_WORK_HOURS } from '@roofline/shared';
import { draftLeadTexts, formatSlot, type LeadDraftInput, leadTemplate, pickTwoSlots } from '../src/agents/followup/draft.ts';
import { LlmRefusedError, LlmUnavailableError } from '../src/providers/llm.ts';
import { ScriptedLlm } from '../src/providers/fakes/scripted-llm.ts';

const ZONE = 'America/Chicago';
// Monday 2026-10-12, 8 AM Central (13:00Z).
const MONDAY_8AM = new Date('2026-10-12T13:00:00Z');
const USAGE = { model: 'scripted', inputTokens: 1, cachedTokens: 0, outputTokens: 1, firstTokenMs: 1, totalMs: 1 };

const lead = (jobId: string, over: Partial<LeadDraftInput> = {}): LeadDraftInput => ({
  jobId,
  customerId: `c-${jobId}`,
  customerFirstName: 'Dana',
  repFirstName: 'Sam',
  address: '1 Main St',
  slots: ['Thursday 10 AM', 'Friday 2 PM'],
  ...over,
});

const good = (jobId: string) => ({ jobId, body: `Hi Dana, Sam here. Could we look at your roof Thursday 10 AM or Friday 2 PM?` });

describe('slots', () => {
  test('pickTwoSlots gives two plain times on different days', () => {
    const slots = pickTwoSlots({ workHours: DEFAULT_WORK_HOURS, busy: [], propertyId: null, timeZone: ZONE, now: MONDAY_8AM });
    expect(slots).not.toBeNull();
    const [a, b] = slots!;
    expect(a).toMatch(/^[A-Z][a-z]+day \d{1,2}(:\d{2})? (AM|PM)$/);
    expect(b).toMatch(/^[A-Z][a-z]+day \d{1,2}(:\d{2})? (AM|PM)$/);
    expect(a.split(' ')[0]).not.toBe(b.split(' ')[0]);
  });

  test('pickTwoSlots is null when everything is busy', () => {
    const busy = [{ start: MONDAY_8AM, end: new Date(MONDAY_8AM.getTime() + 10 * 86_400_000), propertyId: null }];
    expect(pickTwoSlots({ workHours: DEFAULT_WORK_HOURS, busy, propertyId: null, timeZone: ZONE, now: MONDAY_8AM })).toBeNull();
  });

  test('formatSlot', () => {
    expect(formatSlot(new Date('2026-10-15T15:00:00Z'), ZONE)).toBe('Thursday 10 AM');
    expect(formatSlot(new Date('2026-10-16T19:30:00Z'), ZONE)).toBe('Friday 2:30 PM');
    expect(formatSlot(new Date('2026-10-15T17:00:00Z'), ZONE)).toBe('Thursday 12 PM');
  });
});

describe('leadTemplate', () => {
  test('exact text, within limits and clean', () => {
    const t = leadTemplate({ customerFirstName: 'Dana', repFirstName: 'Sam', companyName: 'Acme Roofing', slots: ['Thursday 10 AM', 'Friday 2 PM'] });
    expect(t).toBe("Hi Dana, it's Sam at Acme Roofing. We can come look at your roof Thursday 10 AM or Friday 2 PM. Reply with the one that works.");
    expect(t.length).toBeLessThanOrEqual(300);
    expect(claimsGuard(t).ok).toBe(true);
  });

  test('missing names', () => {
    expect(leadTemplate({ customerFirstName: null, repFirstName: null, companyName: 'Acme', slots: ['A', 'B'] })).toContain("Hi there, it's a member of our team at Acme.");
  });
});

describe('draftLeadTexts', () => {
  test('uses a good body', async () => {
    const llm = new ScriptedLlm();
    llm.scriptDraft({ texts: [good('j1')], refused: false, usage: USAGE });
    const r = await draftLeadTexts(llm, 'Acme Roofing', [lead('j1')]);
    expect(r.anyTemplate).toBe(false);
    expect(r.texts[0]).toMatchObject({ jobId: 'j1', customerId: 'c-j1', fromTemplate: false, body: good('j1').body });
    expect(llm.draftCalls[0]?.instruction).toBe('lead_follow_up');
    expect(llm.draftCalls[0]?.facts[0]?.facts).toEqual({ slot1: 'Thursday 10 AM', slot2: 'Friday 2 PM' });
  });

  test.each([
    ['a price', 'Hi Dana, a new roof is about $500. Thursday 10 AM or Friday 2 PM?'],
    ['coverage talk', 'Hi Dana, your deductible is waived. Thursday 10 AM or Friday 2 PM?'],
    ['a spoken price (D1 sentence guard)', 'Hi Dana, it is twelve grand for the roof. Thursday 10 AM or Friday 2 PM?'],
    ['damage talk (D1 sentence guard)', 'Hi Dana, your roof has hail damage. Thursday 10 AM or Friday 2 PM?'],
    ['missing slots', 'Hi Dana, when can we come by?'],
    ['empty', ''],
  ])('falls back on %s', async (_name, body) => {
    const llm = new ScriptedLlm();
    llm.scriptDraft({ texts: [{ jobId: 'j1', body }], refused: false, usage: USAGE });
    const r = await draftLeadTexts(llm, 'Acme Roofing', [lead('j1')]);
    expect(r.anyTemplate).toBe(true);
    expect(r.texts[0]?.fromTemplate).toBe(true);
    expect(r.texts[0]?.body).toBe(
      "Hi Dana, it's Sam at Acme Roofing. We can come look at your roof Thursday 10 AM or Friday 2 PM. Reply with the one that works.",
    );
  });

  test('an unavailable or refusing Llm gives templates for all', async () => {
    for (const err of [new LlmUnavailableError('down'), new LlmRefusedError('no')]) {
      const llm = new ScriptedLlm();
      llm.scriptDraft(err);
      const r = await draftLeadTexts(llm, 'Acme Roofing', [lead('j1'), lead('j2')]);
      expect(r.anyTemplate).toBe(true);
      expect(r.texts.every((t) => t.fromTemplate)).toBe(true);
    }
  });

  test('refused: true gives templates', async () => {
    const llm = new ScriptedLlm();
    llm.scriptDraft({ texts: [good('j1')], refused: true, usage: USAGE });
    const r = await draftLeadTexts(llm, 'Acme Roofing', [lead('j1')]);
    expect(r.texts[0]?.fromTemplate).toBe(true);
  });

  test('a job missing from the result falls back only for that job', async () => {
    const llm = new ScriptedLlm();
    llm.scriptDraft({ texts: [good('j1')], refused: false, usage: USAGE });
    const r = await draftLeadTexts(llm, 'Acme Roofing', [lead('j1'), lead('j2')]);
    expect(r.texts.map((t) => t.fromTemplate)).toEqual([false, true]);
    expect(r.anyTemplate).toBe(true);
  });

  test('other errors are rethrown, and more than 25 leads is a RangeError', async () => {
    const llm = new ScriptedLlm();
    llm.scriptDraft(new Error('boom'));
    await expect(draftLeadTexts(llm, 'Acme', [lead('j1')])).rejects.toThrow('boom');
    const many = Array.from({ length: 26 }, (_, i) => lead(`j${i}`));
    await expect(draftLeadTexts(new ScriptedLlm(), 'Acme', many)).rejects.toThrow(RangeError);
  });
});
