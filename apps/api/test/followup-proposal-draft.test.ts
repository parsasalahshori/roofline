import { describe, expect, test } from 'vitest';
import { claimsGuard } from '@roofline/shared';
import { draftProposalTexts, type ProposalDraftInput, proposalTemplate } from '../src/agents/followup/draft.ts';
import { LlmUnavailableError } from '../src/providers/llm.ts';
import { ScriptedLlm } from '../src/providers/fakes/scripted-llm.ts';

const USAGE = { model: 'scripted', inputTokens: 1, cachedTokens: 0, outputTokens: 1, firstTokenMs: 1, totalMs: 1 };

const proposal = (jobId: string, over: Partial<ProposalDraftInput> = {}): ProposalDraftInput => ({
  jobId,
  customerId: `c-${jobId}`,
  customerFirstName: 'Pat',
  repFirstName: 'Sam',
  proposalNumber: 'P-0001',
  viewed: false,
  lowestTotalCents: 1240000,
  ...over,
});

const TEMPLATE = "Hi Pat, it's Sam at Acme Roofing. Just checking you got the roof proposal we sent. Happy to answer any questions — reply here or call us.";
const GOOD = 'Hi Pat, Sam here. Did the proposal come through okay? Happy to answer questions.';

describe('proposalTemplate', () => {
  test('exact text and clean', () => {
    const t = proposalTemplate({ customerFirstName: 'Pat', repFirstName: 'Sam', companyName: 'Acme Roofing' });
    expect(t).toBe(TEMPLATE);
    expect(claimsGuard(t).ok).toBe(true);
  });

  test('missing names', () => {
    expect(proposalTemplate({ customerFirstName: null, repFirstName: null, companyName: 'Acme' })).toContain(
      "Hi there, it's a member of our team at Acme.",
    );
  });
});

describe('draftProposalTexts', () => {
  test('uses accepted text and passes facts', async () => {
    const llm = new ScriptedLlm();
    llm.scriptDraft({ texts: [{ jobId: 'j1', body: GOOD }, { jobId: 'j2', body: GOOD }], refused: false, usage: USAGE });
    const r = await draftProposalTexts(llm, 'Acme Roofing', [proposal('j1'), proposal('j2', { viewed: true })]);
    expect(r.anyTemplate).toBe(false);
    expect(r.texts[0]).toMatchObject({ jobId: 'j1', customerId: 'c-j1', body: GOOD, fromTemplate: false });
    expect(llm.draftCalls[0]?.instruction).toBe('proposal_follow_up');
    expect(llm.draftCalls[0]?.facts[0]?.facts).toEqual({ proposalNumber: 'P-0001', viewed: 'no', lowestTotal: '$12,400' });
    expect(llm.draftCalls[0]?.facts[1]?.facts).toMatchObject({ viewed: 'yes' });
  });

  test('unavailable Llm gives template', async () => {
    const llm = new ScriptedLlm();
    llm.scriptDraft(new LlmUnavailableError('down'));
    const r = await draftProposalTexts(llm, 'Acme Roofing', [proposal('j1')]);
    expect(r.anyTemplate).toBe(true);
    expect(r.texts[0]).toMatchObject({ body: TEMPLATE, fromTemplate: true });
  });

  test('refused gives template', async () => {
    const llm = new ScriptedLlm();
    llm.scriptDraft({ texts: [], refused: true, usage: USAGE });
    const r = await draftProposalTexts(llm, 'Acme Roofing', [proposal('j1')]);
    expect(r.anyTemplate).toBe(true);
    expect(r.texts[0]?.body).toBe(TEMPLATE);
  });

  test('guard failure gives template', async () => {
    const llm = new ScriptedLlm();
    llm.scriptDraft({ texts: [{ jobId: 'j1', body: 'We will waive your deductible.' }], refused: false, usage: USAGE });
    const r = await draftProposalTexts(llm, 'Acme Roofing', [proposal('j1')]);
    expect(r.texts[0]).toMatchObject({ body: TEMPLATE, fromTemplate: true });
  });

  test('omitted job gets template, another keeps text', async () => {
    const llm = new ScriptedLlm();
    llm.scriptDraft({ texts: [{ jobId: 'j1', body: GOOD }], refused: false, usage: USAGE });
    const r = await draftProposalTexts(llm, 'Acme Roofing', [proposal('j1'), proposal('j2')]);
    expect(r.anyTemplate).toBe(true);
    expect(r.texts[0]).toMatchObject({ body: GOOD, fromTemplate: false });
    expect(r.texts[1]).toMatchObject({ body: TEMPLATE, fromTemplate: true });
  });

  test('null total leaves out lowestTotal', async () => {
    const llm = new ScriptedLlm();
    llm.scriptDraft({ texts: [{ jobId: 'j1', body: GOOD }], refused: false, usage: USAGE });
    await draftProposalTexts(llm, 'Acme Roofing', [proposal('j1', { lowestTotalCents: null })]);
    expect(llm.draftCalls[0]?.facts[0]?.facts).not.toHaveProperty('lowestTotal');
  });

  test('too many proposals', async () => {
    const llm = new ScriptedLlm();
    const many = Array.from({ length: 26 }, (_, i) => proposal(`j${i}`));
    await expect(draftProposalTexts(llm, 'Acme Roofing', many)).rejects.toThrow(RangeError);
  });

  test('empty input', async () => {
    expect(await draftProposalTexts(new ScriptedLlm(), 'Acme', [])).toEqual({ texts: [], anyTemplate: false });
  });
});
