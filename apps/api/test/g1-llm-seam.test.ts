import { describe, expect, test } from 'vitest';
import { ScriptedLlm } from '../src/providers/fakes/scripted-llm.ts';
import { DRAFT_KINDS, type JobFacts, LlmUnavailableError, type TurnUsage } from '../src/providers/llm.ts';

const USAGE: TurnUsage = { model: 'scripted', inputTokens: 1, cachedTokens: 0, outputTokens: 1, firstTokenMs: 1, totalMs: 2 };

function job(n: number): JobFacts {
  return { jobId: `job-${n}`, customerFirstName: 'Ana', companyName: 'Acme Roofing', repFirstName: null, address: null, facts: { when: 'Mon 9am' } };
}

describe('G1 Llm seams (ScriptedLlm)', () => {
  test('returns scripted drafts in order and records inputs', async () => {
    const llm = new ScriptedLlm();
    const r1 = { texts: [{ jobId: 'job-1', body: 'one' }], usage: USAGE };
    const r2 = { texts: [{ jobId: 'job-2', body: 'two' }], usage: USAGE };
    llm.scriptDraft(r1);
    llm.scriptDraft(r2);
    const a = { instruction: 'reminder' as const, facts: [job(1)] };
    const b = { instruction: 'no_show' as const, facts: [job(2), job(3)] };
    expect(await llm.draftTexts(a)).toEqual(r1);
    expect(await llm.draftTexts(b)).toEqual(r2);
    expect(llm.draftCalls).toEqual([a, b]);
  });

  test('returns scripted extractions in order and records inputs', async () => {
    const llm = new ScriptedLlm();
    const r1 = { facts: { claimNumber: 'C-1' }, usage: USAGE };
    const r2 = { facts: { decision: 'approved' as const }, usage: USAGE };
    llm.scriptExtraction(r1);
    llm.scriptExtraction(r2);
    const now = new Date('2026-10-12T15:00:00Z');
    const a = { text: 'claim C-1', now, timeZone: 'America/Chicago' };
    const b = { text: 'approved', now, timeZone: 'America/Chicago' };
    expect(await llm.extractClaimReply(a)).toEqual(r1);
    expect(await llm.extractClaimReply(b)).toEqual(r2);
    expect(llm.extractionCalls).toEqual([a, b]);
    expect(llm.extractionCalls[0]?.now).toBeInstanceOf(Date);
  });

  test('an empty queue throws LlmUnavailableError', async () => {
    const llm = new ScriptedLlm();
    await expect(llm.draftTexts({ instruction: 'reminder', facts: [job(1)] })).rejects.toBeInstanceOf(LlmUnavailableError);
    await expect(llm.extractClaimReply({ text: 'x', now: new Date(), timeZone: 'UTC' })).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  test('a scripted Error is thrown', async () => {
    const llm = new ScriptedLlm();
    llm.scriptDraft(new Error('boom draft'));
    llm.scriptExtraction(new Error('boom extract'));
    await expect(llm.draftTexts({ instruction: 'reminder', facts: [job(1)] })).rejects.toThrow('boom draft');
    await expect(llm.extractClaimReply({ text: 'x', now: new Date(), timeZone: 'UTC' })).rejects.toThrow('boom extract');
  });

  test('draftTexts with 26 facts throws RangeError', async () => {
    const llm = new ScriptedLlm();
    const ok = { texts: [], usage: USAGE };
    llm.scriptDraft(ok);
    expect(await llm.draftTexts({ instruction: 'reminder', facts: Array.from({ length: 25 }, (_, n) => job(n)) })).toEqual(ok);
    await expect(llm.draftTexts({ instruction: 'reminder', facts: Array.from({ length: 26 }, (_, n) => job(n)) })).rejects.toBeInstanceOf(RangeError);
    expect(llm.draftCalls).toHaveLength(1);
  });

  test('has both methods', () => {
    const llm = new ScriptedLlm();
    expect(typeof llm.draftTexts).toBe('function');
    expect(typeof llm.extractClaimReply).toBe('function');
  });

  test('DRAFT_KINDS lists the nine kinds and the existing methods still work', async () => {
    expect([...DRAFT_KINDS]).toEqual(['proposal_follow_up', 'lead_follow_up', 'claims_ask_filed', 'claims_ask_adjuster_date', 'claims_ask_outcome', 'reminder', 'weather_move', 'no_show', 'review_request']);
    const llm = new ScriptedLlm();
    const s = await llm.summarize({ companyBlock: 'c', transcript: 't', actions: [] });
    expect(s.summary).toBe('Scripted summary.');
  });
});
