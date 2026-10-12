import { describe, expect, test } from 'vitest';
import { claimsGuard } from '@roofline/shared';
import { draftReviewTexts, type ReviewDraftInput, reviewTemplate } from '../src/agents/followup/draft.ts';
import { LlmUnavailableError, MAX_DRAFT_JOBS } from '../src/providers/llm.ts';
import { ScriptedLlm } from '../src/providers/fakes/scripted-llm.ts';

const USAGE = { model: 'scripted', inputTokens: 1, cachedTokens: 0, outputTokens: 1, firstTokenMs: 1, totalMs: 1 };
const LINK = 'https://example.com/review/abc';
const STOP = 'Reply STOP to opt out.';

const review = (jobId: string, over: Partial<ReviewDraftInput> = {}): ReviewDraftInput => ({
  jobId,
  customerId: `c-${jobId}`,
  customerFirstName: 'Pat',
  repFirstName: 'Sam',
  reviewLink: LINK,
  ...over,
});

const GOOD = `Hi Pat, Acme Roofing here. Thanks for choosing us! A quick review means a lot: ${LINK} ${STOP}`;

function scripted(texts: { jobId: string; body: string }[]) {
  const llm = new ScriptedLlm();
  llm.scriptDraft({ texts, refused: false, usage: USAGE });
  return llm;
}

describe('reviewTemplate', () => {
  test('has link and STOP, within 300 chars', () => {
    const t = reviewTemplate({ customerFirstName: 'Pat', companyName: 'Acme Roofing', reviewLink: LINK });
    expect(t).toBe(
      `Hi Pat, it's Acme Roofing. Thanks for choosing us for your new roof. If you have a minute, a short review helps a lot: ${LINK} ${STOP}`,
    );
    expect(t.length).toBeLessThanOrEqual(300);
    expect(claimsGuard(t).ok).toBe(true);
  });

  test('long link drops the lead-in', () => {
    const link = 'https://example.com/' + 'a'.repeat(150);
    const t = reviewTemplate({ customerFirstName: 'Pat', companyName: 'Acme Roofing', reviewLink: link });
    expect(t).not.toContain('If you have a minute, ');
    expect(t).toContain('Thanks for choosing us for your new roof. A short review helps a lot: ');
    expect(t.length).toBeLessThanOrEqual(300);
    expect(t).toContain(link);
    expect(t).toContain(STOP);
  });

  test('null first name', () => {
    expect(reviewTemplate({ customerFirstName: null, companyName: 'Acme', reviewLink: LINK })).toContain('Hi there,');
  });
});

describe('draftReviewTexts', () => {
  test('empty input', async () => {
    expect(await draftReviewTexts(new ScriptedLlm(), 'Acme Roofing', [])).toEqual({ texts: [], anyTemplate: false });
  });

  test('uses accepted text and passes request', async () => {
    const llm = scripted([{ jobId: 'j1', body: GOOD }]);
    const r = await draftReviewTexts(llm, 'Acme Roofing', [review('j1')]);
    expect(r.anyTemplate).toBe(false);
    expect(r.texts[0]).toEqual({ jobId: 'j1', customerId: 'c-j1', body: GOOD, fromTemplate: false });
    expect(llm.draftCalls[0]?.instruction).toBe('review_request');
    expect(llm.draftCalls[0]?.facts[0]?.facts).toEqual({ reviewLink: LINK });
  });

  const template = reviewTemplate({ customerFirstName: 'Pat', companyName: 'Acme Roofing', reviewLink: LINK });

  test.each([
    ['missing link', `Hi Pat, thanks for choosing us! A review helps. ${STOP}`],
    ['missing STOP line', `Hi Pat, thanks for choosing us! A review helps: ${LINK}`],
    ['fails claims guard', `Hi Pat, we will waive your deductible, review us: ${LINK} ${STOP}`],
    ['too long', `Hi Pat, ${'thanks '.repeat(50)}${LINK} ${STOP}`],
  ])('%s gives template', async (_n, body) => {
    const r = await draftReviewTexts(scripted([{ jobId: 'j1', body }]), 'Acme Roofing', [review('j1')]);
    expect(r.anyTemplate).toBe(true);
    expect(r.texts[0]).toMatchObject({ body: template, fromTemplate: true });
  });

  test('unavailable gives template', async () => {
    const llm = new ScriptedLlm();
    llm.scriptDraft(new LlmUnavailableError('down'));
    const r = await draftReviewTexts(llm, 'Acme Roofing', [review('j1')]);
    expect(r.anyTemplate).toBe(true);
    expect(r.texts[0]).toMatchObject({ body: template, fromTemplate: true });
  });

  test('refused gives template', async () => {
    const llm = new ScriptedLlm();
    llm.scriptDraft({ texts: [], refused: true, usage: USAGE });
    const r = await draftReviewTexts(llm, 'Acme Roofing', [review('j1')]);
    expect(r.texts[0]).toMatchObject({ body: template, fromTemplate: true });
  });

  test('too many inputs', async () => {
    const many = Array.from({ length: MAX_DRAFT_JOBS + 1 }, (_, i) => review(`j${i}`));
    await expect(draftReviewTexts(new ScriptedLlm(), 'Acme', many)).rejects.toThrow(RangeError);
  });
});
