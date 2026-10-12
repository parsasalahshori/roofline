import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { stepTypes } from '@roofline/shared';
import type { StepView } from '../src/api/types.ts';
import { emailBatchKit, EmailBatchPreview } from '../src/features/approvals/steps/EmailBatchPreview.tsx';

afterEach(() => cleanup());

const CUSTOMER_A = '5f1c9a2e-3b4d-4c6e-8f70-1a2b3c4d5e6f';
const CUSTOMER_B = '0b7e4d2a-9c1f-4a8b-9d3e-6f5a4b3c2d1e';
const STORM = '7c2e8f10-4b6a-4d3e-9a5c-2f1e0d9c8b7a';
const SAMPLE = 'Hi Sam, Radar shows hail up to 1.75" near Maple St.';
const FULL_BODY = 'Hail hit {company} country. Find out more at {company_address}. {unsubscribe}';

function step(overrides: Partial<StepView> = {}): StepView {
  return {
    id: 's1',
    position: 1,
    type: 'send_email_batch',
    approvalClass: 'message',
    enabled: true,
    version: 1,
    status: 'pending',
    preview: {
      title: 'Email 2 customers',
      lines: ['Marketing email', "Customers who can't be emailed are skipped."],
      messageSample: SAMPLE,
      recipientCount: 2,
    },
    canApprove: true,
    attempts: 0,
    result: null,
    errorPlain: null,
    payload: {
      purpose: 'marketing',
      subject: 'Hail near your home on Maple St',
      body: FULL_BODY,
      customerIds: [CUSTOMER_A, CUSTOMER_B],
      companyStormId: STORM,
    },
    ...overrides,
  };
}

describe('the email preview', () => {
  it('renders the subject, the per-customer sample and the recipient count', () => {
    render(<EmailBatchPreview step={step()} canApprove={true} />);
    expect(screen.getByRole('heading', { name: 'Hail near your home on Maple St' })).toBeTruthy();
    expect(screen.getByText(SAMPLE)).toBeTruthy();
    expect(screen.getByText('2 customers get this email')).toBeTruthy();
    expect(screen.getByText('Marketing email')).toBeTruthy();
    expect(screen.getByText('Radar-estimated hail sizes')).toBeTruthy();
    expect(screen.getByText('What each customer reads')).toBeTruthy();
  });

  it('falls back to the server preview when the payload is missing or mistyped', () => {
    const { unmount } = render(<EmailBatchPreview step={step({ payload: undefined })} canApprove={true} />);
    expect(screen.getByText(SAMPLE)).toBeTruthy();
    expect(screen.getByText('2 customers get this email')).toBeTruthy();
    unmount();
    render(<EmailBatchPreview step={step({ payload: { subject: 42, customerIds: 'x' } as never })} canApprove={true} />);
    expect(screen.getByText(SAMPLE)).toBeTruthy();
    expect(screen.getByText('2 customers get this email')).toBeTruthy();
  });
});

describe('the email edit fields', () => {
  it('returns the subject and the body with their payload values', () => {
    const fields = emailBatchKit.editFields(step());
    expect(fields).toEqual([
      { id: 'subject', label: 'Subject', kind: 'text', value: 'Hail near your home on Maple St' },
      {
        id: 'body',
        label: 'Message',
        kind: 'multiline',
        value: FULL_BODY,
        help: 'Keep {company}, {company_address} and {unsubscribe} in the message.',
      },
    ]);
  });

  it('gives empty values when the payload has no text', () => {
    const fields = emailBatchKit.editFields(step({ payload: undefined }));
    expect(fields.map((field) => field.value)).toEqual(['', '']);
  });
});

describe('the email payload after an edit', () => {
  it('keeps the other keys and replaces the subject and body', () => {
    const payload = emailBatchKit.toPayload(step(), { subject: 'New subject', body: 'New body {company}' });
    expect(payload).toEqual({
      purpose: 'marketing',
      subject: 'New subject',
      body: 'New body {company}',
      customerIds: [CUSTOMER_A, CUSTOMER_B],
      companyStormId: STORM,
    });
  });

  it('flags the missing unsubscribe token and shows no warning for a complete body', () => {
    const missing = emailBatchKit.warnings?.(step(), { subject: 'x', body: 'Hi {company}, {company_address}' });
    expect(missing).toEqual({ body: ['This email is missing {unsubscribe}. It will not be sent without it.'] });
    const complete = emailBatchKit.warnings?.(step(), {
      subject: 'x',
      body: 'Hi {company}, {company_address}, {unsubscribe}',
    });
    expect(complete).toEqual({});
  });

  it('passes the shared payload check for a good edit and rejects a blank subject', () => {
    const type = stepTypes.send_email_batch;
    const good = type.payload.safeParse(emailBatchKit.toPayload(step(), { subject: 'Hail today', body: FULL_BODY }));
    expect(good.success).toBe(true);

    const blank = type.payload.safeParse(emailBatchKit.toPayload(step(), { subject: '   ', body: FULL_BODY }));
    expect(blank.success).toBe(false);
    expect(blank.error?.issues.map((issue) => issue.message)).toContain('Please write the subject.');
  });
});
