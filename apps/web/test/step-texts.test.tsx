import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { StepView } from '../src/api/types.ts';
import { SendTextsPreview, sendTextsKit } from '../src/features/approvals/steps/SendTextsPreview.tsx';
import { renderAt, stubApi } from './helpers.tsx';

afterEach(() => cleanup());

const CUSTOMER = '5f1c9a2e-3b4d-4c6e-8f70-1a2b3c4d5e6f';
const JOB = '0b7e4d2a-9c1f-4a8b-9d3e-6f5a4b3c2d1e';
const STOP = 'Reply STOP to opt out';

function messages(n: number, suffix = '') {
  return Array.from({ length: n }, (_, i) => ({
    customerId: CUSTOMER,
    jobId: i === 0 ? JOB : null,
    body: `Body number ${i + 1}${suffix}`,
  }));
}

function step(n = 3, kind = 'reminder', suffix = ''): StepView {
  return {
    id: 's1',
    position: 1,
    type: 'send_personal_texts',
    approvalClass: 'message',
    enabled: true,
    version: 1,
    status: 'pending',
    preview: { title: 'Texts', lines: [] },
    canApprove: true,
    attempts: 0,
    result: null,
    errorPlain: null,
    payload: { purpose: 'informational', kind, messages: messages(n, suffix), dedupePrefix: 'follow-up:abc' },
  };
}

describe('the texts kit data', () => {
  it('reviews with a count title and the first three bodies', () => {
    const review = sendTextsKit.review(step(3));
    expect(review.title).toBe('Send 3 personal texts');
    expect(review.lines).toEqual(['Body number 1', 'Body number 2', 'Body number 3']);
    expect(review.recipientCount).toBe(3);
    expect(review.messageSample).toBe('Body number 1');
    expect(sendTextsKit.review(step(1)).title).toBe('Send 1 personal text');
    expect(sendTextsKit.review(step(5)).lines).toHaveLength(3);
  });

  it('has one multiline field per text', () => {
    const fields = sendTextsKit.editFields(step(3));
    expect(fields.map((f) => f.id)).toEqual(['m0', 'm1', 'm2']);
    expect(fields.map((f) => f.label)).toEqual(['Text to customer 1', 'Text to customer 2', 'Text to customer 3']);
    expect(fields.map((f) => f.value)).toEqual(['Body number 1', 'Body number 2', 'Body number 3']);
    expect(fields.every((f) => f.kind === 'multiline')).toBe(true);
  });

  it('round-trips and changes only the edited body', () => {
    const s = step(3);
    const values = Object.fromEntries(sendTextsKit.editFields(s).map((f) => [f.id, f.value]));
    expect(sendTextsKit.toPayload(s, values)).toEqual(s.payload);
    const edited = sendTextsKit.toPayload(s, { ...values, m1: 'New' }) as { messages: { body: string }[] };
    expect(edited).toMatchObject({ purpose: 'informational', kind: 'reminder', dedupePrefix: 'follow-up:abc' });
    expect(edited.messages.map((m) => m.body)).toEqual(['Body number 1', 'New', 'Body number 3']);
    expect(edited.messages[0]).toMatchObject({ customerId: CUSTOMER, jobId: JOB });
    expect(sendTextsKit.toPayload(s, {})).toEqual(s.payload);
  });

  it('rejects empty and too long texts', () => {
    const s = step(3);
    const errors = sendTextsKit.fieldErrors?.(s, { m0: '  ', m1: 'x'.repeat(481), m2: 'x'.repeat(480) });
    expect(errors).toEqual({
      m0: 'Please write the text or remove it.',
      m1: 'Please keep each text to 480 characters or fewer.',
    });
    expect(sendTextsKit.fieldErrors?.(s, { m0: 'a' })).toEqual({});
  });

  it('warns about the stop line only for review texts', () => {
    const review = step(2, 'review');
    const warn = sendTextsKit.warnings?.(review, { m0: 'Please review us', m1: `Thanks. ${STOP}.` });
    expect(warn).toEqual({ m0: ['Review requests must end with “Reply STOP to opt out.”'] });
    expect(sendTextsKit.warnings?.(review, { m0: `Hi ${STOP}`, m1: `Bye ${STOP}.` })).toEqual({});
    expect(sendTextsKit.warnings?.(step(2, 'reminder'), { m0: 'no stop' })).toEqual({});
  });
});

describe('the texts preview', () => {
  it('shows 20 rows and expands the rest', async () => {
    const { user } = renderAt(<SendTextsPreview step={step(25)} canApprove={true} taskId="t1" />);
    expect(screen.getAllByText(/^Body number/)).toHaveLength(20);
    expect(screen.getByText('Customer 1')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Show 5 more' }));
    expect(screen.getAllByText(/^Body number/)).toHaveLength(25);
    expect(screen.queryByRole('button', { name: /Show/ })).toBeNull();
  });

  it('removes a text through Review\'s save, keeping the rest of the payload', async () => {
    const saved: Record<string, unknown>[] = [];
    const { user } = renderAt(
      <SendTextsPreview step={step(3)} canApprove={true} taskId="t1" onSavePayload={(p) => saved.push(p)} />,
    );
    await user.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    expect(saved).toEqual([
      { purpose: 'informational', kind: 'reminder', dedupePrefix: 'follow-up:abc', messages: messages(3).slice(1) },
    ]);
  });

  it('offers no Remove once the plan can no longer change', () => {
    renderAt(<SendTextsPreview step={step(3)} canApprove={true} taskId="t1" />);
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.getAllByText(/^Body number/)).toHaveLength(3);
  });

  it('keeps the last text and shows a hint', () => {
    renderAt(<SendTextsPreview step={step(1)} canApprove={true} taskId="t1" onSavePayload={() => {}} />);
    expect(screen.getByText('Keep at least one text, or turn this step off.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('names each text\'s customer', async () => {
    stubApi({ [`GET /api/customers/${CUSTOMER}`]: () => ({ body: { displayName: 'Maria Lopez', firstName: 'Maria' } }) });
    renderAt(<SendTextsPreview step={step(2)} canApprove={true} taskId="t1" />);
    expect(await screen.findAllByText('Maria Lopez')).toHaveLength(2);
  });

  it('shows the stop warning for review texts', () => {
    renderAt(<SendTextsPreview step={step(2, 'review')} canApprove={true} taskId="t1" />);
    expect(screen.getAllByText('Review requests must end with “Reply STOP to opt out.”')).toHaveLength(2);
  });

  it('uses plain words', () => {
    const { router } = renderAt(<SendTextsPreview step={step(3, 'review')} canApprove={true} taskId="t1" />);
    void router;
    const container = document.body;
    const text = (container.textContent ?? '').toLowerCase();
    for (const word of ['payload', 'step', 'dedupe', 'json', 'api']) expect(text).not.toContain(word);
  });
});
