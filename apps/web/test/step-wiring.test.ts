import { describe, expect, it } from 'vitest';
import type { StepView, TaskView } from '../src/api/types.ts';
import { editableFields, editableText } from '../src/features/approvals/editable.ts';
import { toReviewStep } from '../src/features/approvals/toReviewStep.ts';
import { makeTask } from './helpers.tsx';

const STORM = '7c2e8f10-4b6a-4d3e-9a5c-2f1e0d9c8b7a';

function step(overrides: Partial<StepView> = {}): StepView {
  return {
    id: 's1',
    position: 1,
    type: 'demo_message',
    approvalClass: 'message',
    enabled: true,
    version: 1,
    status: 'pending',
    preview: { title: 'Text 31 customers', lines: ['A line'] },
    canApprove: true,
    attempts: 0,
    result: null,
    errorPlain: null,
    payload: { label: 'Text 31 customers' },
    ...overrides,
  };
}

const draft = (steps: StepView[]): TaskView => makeTask({ id: 't1', steps, status: 'draft' });

describe('the review step for the new step types', () => {
  it('is editable for an email batch', () => {
    const s = step({
      type: 'send_email_batch',
      approvalClass: 'message',
      preview: { title: 'Email 2 customers', lines: [], recipientCount: 2 },
      payload: { subject: 'Hail near you', body: 'Body {company} {company_address} {unsubscribe}', customerIds: [] },
    });
    expect(toReviewStep(s, draft([s])).editable).toBe(true);
  });

  it('is editable for a build_routes step', () => {
    const s = step({
      type: 'build_routes',
      approvalClass: 'message',
      preview: { title: '1 door-knock route · 12 doors', lines: [] },
      payload: { repUserIds: ['11111111-1111-4111-8111-111111111111'], doors: 12, maxDoors: 12, companyStormId: STORM },
    });
    expect(toReviewStep(s, draft([s])).editable).toBe(true);
  });

  it('is editable for an ad campaign, and its preview carries the approved maximum', () => {
    const s = step({
      type: 'create_ad_campaign',
      approvalClass: 'spend',
      preview: { title: 'Google ads on the hail area', lines: [], maxSpendCents: 15000 },
      payload: {
        companyStormId: STORM,
        platform: 'google',
        maxSpendCents: 15000,
        days: 7,
        headline: 'Hail damage?',
        description: 'Local roofers.',
        keywords: ['roof repair'],
      },
    });
    const review = toReviewStep(s, draft([s]));
    expect(review.editable).toBe(true);
    expect(review.preview.maxSpendCents).toBe(s.payload?.maxSpendCents);
    expect(review.preview.maxSpendCents).toBe(15000);
  });

  it('keeps the text edit of an SMS batch and its preview unchanged', () => {
    const s = step({
      type: 'send_sms_batch',
      approvalClass: 'message',
      preview: { title: 'Text 31 customers', lines: ['A line'] },
      payload: { body: 'Hello from {company}' },
    });
    const review = toReviewStep(s, draft([s]));
    expect(review.editable).toBe(true);
    expect(review.preview).toEqual(s.preview);
    expect(editableText(s)).toEqual({ key: 'body', value: 'Hello from {company}' });
  });

  it('is not editable for a no-op demo step', () => {
    const s = step({ type: 'demo_noop', payload: { label: 'Nothing' } });
    expect(toReviewStep(s, draft([s])).editable).toBe(false);
  });
});

describe('the edit fields the sheet shows', () => {
  it('are none for a demo message', () => {
    expect(editableFields(step())).toEqual([]);
  });

  it('are the campaign fields for an ad campaign', () => {
    const s = step({
      type: 'create_ad_campaign',
      approvalClass: 'spend',
      payload: {
        companyStormId: STORM,
        platform: 'google',
        maxSpendCents: 15000,
        days: 7,
        headline: 'Hail damage?',
        description: 'Local roofers.',
        keywords: ['roof repair'],
      },
    });
    expect(editableFields(s).length).toBeGreaterThan(0);
    expect(editableFields(s).map((f) => f.id)).toContain('maxSpend');
  });
});
