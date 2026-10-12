import { describe, expect, test } from 'vitest';
import { STEP_TYPES, isStepType, stepMinutes, stepTypes, type StepType } from '../src/steps.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

/** The first message the payload schema gives for `value`, or null when it passes. */
function schemaMessage(type: StepType, value: unknown): string | null {
  const result = stepTypes[type].payload.safeParse(value, { error: () => 'GENERIC' });
  return result.success ? null : (result.error.issues[0]?.message ?? 'no message');
}

const LINK_MESSAGE = 'Keep {link} in the message so they can open the proposal.';

const proposal = stepTypes.send_proposal;
const proposalPayload = (overrides: Record<string, unknown> = {}) => ({
  proposalId: ID,
  customerId: ID2,
  body: 'Hi Dana, your proposal: {link}',
  basis: 'estimate',
  totals: [1190000, 1425000, 1760000],
  ...overrides,
});

const report = stepTypes.order_exact_report;
const reportPayload = (overrides: Record<string, unknown> = {}) => ({
  orderId: ID,
  measurementId: ID2,
  address: '12 Oak St, Irvine, CA',
  maxSpendCents: 2500,
  ...overrides,
});

describe('send_proposal', () => {
  test('is a message step', () => {
    expect(proposal.type).toBe('send_proposal');
    expect(proposal.approvalClass).toBe('message');
  });

  test('a good payload parses', () => {
    expect(proposal.payload.parse(proposalPayload())).toMatchObject({
      proposalId: ID,
      customerId: ID2,
      basis: 'estimate',
      totals: [1190000, 1425000, 1760000],
    });
  });

  test('validate passes a body that keeps {link}', () => {
    const p = proposal.payload.parse(proposalPayload());
    expect(proposal.validate!(p, { companyName: 'Acme Roofing' })).toBeNull();
  });

  test('validate refuses a body without {link} with the exact sentence', () => {
    const p = proposal.payload.parse(proposalPayload({ body: 'Hi Dana, your proposal is ready.' }));
    expect(proposal.validate!(p, { companyName: 'Acme Roofing' })).toBe(LINK_MESSAGE);
  });

  test('an empty body, a body of 641 characters, an unknown key, a non-uuid id and a bad basis all fail the payload', () => {
    expect(proposal.payload.safeParse(proposalPayload({ body: '' })).success).toBe(false);
    expect(proposal.payload.safeParse(proposalPayload({ body: 'x'.repeat(641) })).success).toBe(false);
    expect(proposal.payload.safeParse(proposalPayload({ extra: 1 })).success).toBe(false);
    expect(proposal.payload.safeParse(proposalPayload({ proposalId: 'nope' })).success).toBe(false);
    expect(proposal.payload.safeParse(proposalPayload({ basis: 'guess' })).success).toBe(false);
  });

  test('payload failures give the exact plain-language messages', () => {
    expect(schemaMessage('send_proposal', proposalPayload())).toBeNull();
    expect(schemaMessage('send_proposal', proposalPayload({ body: '' }))).toBe('Please write the message.');
    expect(schemaMessage('send_proposal', proposalPayload({ body: '   ' }))).toBe('Please write the message.');
    expect(schemaMessage('send_proposal', proposalPayload({ body: 'x'.repeat(641) }))).toBe('Please keep the message to 640 characters or fewer.');
    expect(schemaMessage('send_proposal', proposalPayload({ proposalId: 'nope' }))).toBe('Please pick a proposal.');
    expect(schemaMessage('send_proposal', proposalPayload({ customerId: 'nope' }))).toBe('Please pick a customer from your list.');
    expect(schemaMessage('send_proposal', proposalPayload({ basis: 'guess' }))).toBe('Please pick estimate or exact.');
    expect(schemaMessage('send_proposal', proposalPayload({ totals: [1, 2, 3, 4] }))).toBe('Please check the prices.');
    expect(schemaMessage('send_proposal', proposalPayload({ totals: [] }))).toBe('Please check the prices.');
    expect(schemaMessage('send_proposal', proposalPayload({ totals: [-1] }))).toBe('Please check the prices.');
    expect(schemaMessage('send_proposal', proposalPayload({ totals: [1.5] }))).toBe('Please check the prices.');
  });

  test('preview names the customer, shows the three tier totals and a rendered sample with a link', () => {
    const p = proposal.payload.parse(proposalPayload());
    const preview = proposal.preview(p, { companyName: 'Acme Roofing', sampleFirstName: 'Dana' });
    expect(preview.title).toBe('Text the proposal to Dana');
    expect(preview.lines[0]).toBe('Good $11,900 · Better $14,250 · Best $17,600');
    expect(preview.lines).toHaveLength(2);
    expect(preview.messageSample).toBeDefined();
    expect(preview.messageSample).not.toContain('{link}');
    expect(preview.messageSample).toContain('https://');
    expect(preview.recipientCount).toBe(1);
  });

  test('saves 20 minutes whatever the result', () => {
    const p = proposal.payload.parse(proposalPayload());
    expect(stepMinutes(proposal, p, {}).minutes).toBe(20);
  });
});

describe('order_exact_report', () => {
  test('is a spend step', () => {
    expect(report.type).toBe('order_exact_report');
    expect(report.approvalClass).toBe('spend');
  });

  test('a good payload parses', () => {
    expect(report.payload.parse(reportPayload())).toMatchObject({
      orderId: ID,
      measurementId: ID2,
      address: '12 Oak St, Irvine, CA',
      maxSpendCents: 2500,
    });
  });

  test('maxSpendCents must be a whole number of 0 or more', () => {
    expect(report.payload.safeParse(reportPayload({ maxSpendCents: 1.5 })).success).toBe(false);
    expect(report.payload.safeParse(reportPayload({ maxSpendCents: -1 })).success).toBe(false);
  });

  test('a missing address fails the payload', () => {
    expect(report.payload.safeParse({ orderId: ID, measurementId: ID2, maxSpendCents: 2500 }).success).toBe(false);
  });

  test('a blank address gives the exact message', () => {
    expect(schemaMessage('order_exact_report', reportPayload())).toBeNull();
    expect(schemaMessage('order_exact_report', reportPayload({ address: '  ' }))).toBe('Please enter the address.');
  });

  test('preview gives the title, the address as the one line and the ceiling', () => {
    const p = report.payload.parse(reportPayload());
    expect(report.preview(p, { companyName: 'Acme Roofing' })).toEqual({
      title: 'Order an exact roof report',
      lines: ['12 Oak St, Irvine, CA'],
      maxSpendCents: 2500,
    });
  });

  test('saves 10 minutes whatever the result', () => {
    const p = report.payload.parse(reportPayload());
    expect(stepMinutes(report, p, {}).minutes).toBe(10);
  });
});

describe('registry for E1 step types', () => {
  test('STEP_TYPES includes both new keys', () => {
    expect(STEP_TYPES).toContain('send_proposal');
    expect(STEP_TYPES).toContain('order_exact_report');
    expect(Object.keys(stepTypes)).toEqual(expect.arrayContaining(['send_proposal', 'order_exact_report']));
  });

  test('isStepType accepts the new type names', () => {
    expect(isStepType('send_proposal')).toBe(true);
    expect(isStepType('order_exact_report')).toBe(true);
    expect(isStepType('send_proposal_x')).toBe(false);
  });
});
