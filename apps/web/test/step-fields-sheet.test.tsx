import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StepView, StormPhoto, StormSettingsBody, TaskView } from '../src/api/types.ts';
import { review } from '../src/copy/review.ts';
import { stepRoutes } from '../src/copy/stepRoutes.ts';
import { Review } from '../src/features/approvals/Review.tsx';
import { StepFieldsSheet } from '../src/features/approvals/StepFieldsSheet.tsx';
import type { StepKit } from '../src/features/approvals/steps/types.ts';
import { adCampaignKit } from '../src/features/approvals/steps/AdCampaignPreview.tsx';
import { buildRoutesKit } from '../src/features/approvals/steps/BuildRoutesPreview.tsx';
import { makeTask, renderAt, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi> | undefined;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
  api = undefined;
});

const COMPANY_STORM_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const CUSTOMER_ID = '3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c';
const REP_A = '1b4e28ba-2fa3-41ed-a261-0242ac120002';
const REP_B = '7d9e4b2a-5c1f-4e8a-9b3d-6f2a1c0e8d7b';

/** A send_email_batch step's payload that the shared schema and validate both accept. */
const EMAIL_PAYLOAD = {
  purpose: 'marketing',
  subject: 'Hail on your street',
  body: 'Hail hit {company} neighbours this week. Reply STOP to opt out.',
  customerIds: [CUSTOMER_ID],
};

function emailStep(overrides: Partial<StepView> = {}): StepView {
  return {
    id: 's1',
    position: 1,
    type: 'send_email_batch',
    approvalClass: 'message',
    enabled: true,
    version: 3,
    status: 'pending',
    preview: { title: 'Email 1 customer', lines: [], recipientCount: 1 },
    canApprove: true,
    attempts: 0,
    result: null,
    errorPlain: null,
    payload: { ...EMAIL_PAYLOAD },
    ...overrides,
  };
}

/** A small kit with a subject and a message, the way a step kit's Edit fields look. */
function inlineKit(overrides: Partial<StepKit> = {}): StepKit {
  return {
    Preview: () => null,
    review: (step) => step.preview,
    editFields: (step) => [
      { id: 'subject', label: 'Subject', kind: 'text', value: String(step.payload?.subject ?? '') },
      { id: 'body', label: 'Message', kind: 'multiline', value: String(step.payload?.body ?? '') },
    ],
    toPayload: (step, values) => ({ ...(step.payload ?? {}), subject: values.subject, body: values.body }),
    ...overrides,
  };
}

function teamStub(members: { userId: string; name: string }[] = []) {
  return stubApi({
    'GET /api/team': () => ({
      body: {
        members: members.map((member, i) => ({
          id: `m${i}`,
          userId: member.userId,
          name: member.name,
          email: `${i}@example.com`,
          role: 'rep',
          canApproveSpend: false,
          status: 'active',
          stormAlertEmail: false,
        })),
        invites: [],
      },
    }),
  });
}

describe('the generic edit sheet', () => {
  it('shows the kit fields, filled from the step', async () => {
    api = teamStub();
    renderAt(<StepFieldsSheet step={emailStep()} kit={inlineKit()} saving={false} onSave={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByRole('dialog', { name: review.editTitle })).toBeInTheDocument();
    expect(screen.getByLabelText('Subject')).toHaveValue('Hail on your street');
    expect(screen.getByLabelText('Message')).toHaveValue(EMAIL_PAYLOAD.body);
    await waitFor(() => expect(api?.count('GET /api/team')).toBeGreaterThan(0));
  });

  it('uses the decimal keyboard for a number field that asks for it, and numeric otherwise', async () => {
    api = teamStub();
    const kit = inlineKit({
      editFields: () => [
        { id: 'amount', label: 'Amount', kind: 'number', inputMode: 'decimal', value: '1.5' },
        { id: 'count', label: 'Count', kind: 'number', value: '3' },
      ],
    });
    renderAt(<StepFieldsSheet step={emailStep()} kit={kit} saving={false} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByLabelText('Amount')).toHaveAttribute('inputmode', 'decimal');
    expect(screen.getByLabelText('Count')).toHaveAttribute('inputmode', 'numeric');
    await waitFor(() => expect(api?.count('GET /api/team')).toBeGreaterThan(0));
  });

  it('saves the payload that toPayload builds from the edited values', async () => {
    api = teamStub();
    const onSave = vi.fn();
    const { user } = renderAt(
      <StepFieldsSheet step={emailStep()} kit={inlineKit()} saving={false} onSave={onSave} onClose={vi.fn()} />,
    );

    const subject = screen.getByLabelText('Subject');
    await user.clear(subject);
    await user.type(subject, 'Hail this week');
    await user.click(screen.getByRole('button', { name: review.save }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ ...EMAIL_PAYLOAD, subject: 'Hail this week' });
  });

  it('stops a blank subject with the shared sentence and does not save', async () => {
    api = teamStub();
    const onSave = vi.fn();
    const { user } = renderAt(
      <StepFieldsSheet step={emailStep()} kit={inlineKit()} saving={false} onSave={onSave} onClose={vi.fn()} />,
    );

    const subject = screen.getByLabelText('Subject');
    await user.clear(subject);
    await user.type(subject, '   ');
    await user.click(screen.getByRole('button', { name: review.save }));

    expect(await screen.findByText('Please write the subject.')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows the kit fieldErrors on their fields and does not save', async () => {
    api = teamStub();
    const onSave = vi.fn();
    const kit = inlineKit({
      fieldErrors: (_step, values): Record<string, string> => (values.body === '' ? { body: 'Please write the message.' } : {}),
    });
    const { user } = renderAt(<StepFieldsSheet step={emailStep()} kit={kit} saving={false} onSave={onSave} onClose={vi.fn()} />);

    await user.clear(screen.getByLabelText('Message'));
    await user.click(screen.getByRole('button', { name: review.save }));

    expect(await screen.findByText('Please write the message.')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows a kit warning under its field without blocking the save', async () => {
    api = teamStub();
    const onSave = vi.fn();
    const kit = inlineKit({ warnings: () => ({ body: ['Add {company} so customers know who is writing.'] }) });
    const { user } = renderAt(<StepFieldsSheet step={emailStep()} kit={kit} saving={false} onSave={onSave} onClose={vi.fn()} />);

    expect(screen.getByText('Add {company} so customers know who is writing.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: review.save }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('shows the server sentence for a rejected save', () => {
    api = teamStub();
    renderAt(
      <StepFieldsSheet
        step={emailStep()}
        kit={inlineKit()}
        saving={false}
        error="Please keep the message to 10,000 characters or fewer."
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Please keep the message to 10,000 characters or fewer.')).toBeInTheDocument();
  });

  it('lists the team as the reps to pick, and keeps a rep who is no longer on the team', async () => {
    api = teamStub([{ userId: REP_A, name: 'Ana Lopez' }]);
    const step: StepView = {
      ...emailStep(),
      id: 's2',
      type: 'build_routes',
      approvalClass: 'internal',
      preview: { title: '1 door-knock route · 30 doors', lines: [] },
      payload: { companyStormId: COMPANY_STORM_ID, repUserIds: [REP_A, REP_B], maxDoors: 30 },
    };
    renderAt(<StepFieldsSheet step={step} kit={buildRoutesKit} saving={false} onSave={vi.fn()} onClose={vi.fn()} />);

    const ana = await screen.findByRole('checkbox', { name: 'Ana Lopez' });
    expect(ana).toBeChecked();
    expect(screen.getByRole('checkbox', { name: stepRoutes.repFallback(1) })).toBeChecked();
    expect(screen.getByLabelText(stepRoutes.doorsLabel)).toHaveValue('30');
  });

  it('stops a build_routes save with no rep picked, on the reps field', async () => {
    api = teamStub([{ userId: REP_A, name: 'Ana Lopez' }]);
    const onSave = vi.fn();
    const step: StepView = {
      ...emailStep(),
      type: 'build_routes',
      approvalClass: 'internal',
      payload: { companyStormId: COMPANY_STORM_ID, repUserIds: [REP_A], maxDoors: 30 },
    };
    const { user } = renderAt(<StepFieldsSheet step={step} kit={buildRoutesKit} saving={false} onSave={onSave} onClose={vi.fn()} />);

    await user.click(await screen.findByRole('checkbox', { name: 'Ana Lopez' }));
    await user.click(screen.getByRole('button', { name: review.save }));

    expect(await screen.findByText(stepRoutes.pickOneRep)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('a draft plan with an email step', () => {
  // Skipped until P3's toReviewStep sets `editable` for kit steps: the Edit button is not drawn before that.
  it('opens the edit sheet from the step\'s Edit button', async () => {
    api = teamStub();
    const plan: TaskView = makeTask({
      id: 't1',
      status: 'draft',
      steps: [emailStep({ id: 's1' })],
    });
    api.routes['GET /api/approvals/t1'] = () => ({ body: plan });
    const { user } = renderAt(<Review taskId="t1" />, '/approvals/t1');

    await user.click(await screen.findByRole('button', { name: review.edit }));

    expect(screen.getByRole('dialog', { name: review.editTitle })).toBeInTheDocument();
    expect(within(screen.getByRole('dialog', { name: review.editTitle })).getByLabelText('Subject')).toHaveValue(EMAIL_PAYLOAD.subject);
  });
});

const PHOTO = '3f0b6a52-9c1d-4e7a-8b2f-5d6c7e8f9a01';
const OTHER_PHOTO = '5a1c9e3d-2b7f-4c8e-9d0a-6e4f2b1a0c3d';

/** A create_ad_campaign step as the server stores it, with `payload` overrides. */
function adStep(payload: Record<string, unknown> = {}): StepView {
  return {
    id: 's3',
    position: 1,
    type: 'create_ad_campaign',
    approvalClass: 'spend',
    enabled: true,
    version: 1,
    status: 'pending',
    preview: { title: 'Google ads on the hail area', lines: [], maxSpendCents: 15000 },
    canApprove: true,
    attempts: 0,
    result: null,
    errorPlain: null,
    payload: {
      companyStormId: COMPANY_STORM_ID,
      platform: 'google',
      maxSpendCents: 15000,
      days: 7,
      headline: 'Hail damage?',
      description: 'Local roofers.',
      keywords: ['roof repair'],
      ...payload,
    },
  };
}

/** The company's storm settings with the given ad photos. */
function settingsWith(photos: StormPhoto[]): StormSettingsBody {
  const templates = { smsTemplate: 'Hi {first_name}', emailSubject: 'Hail near you', emailTemplate: 'Hi {first_name},' };
  return {
    ...templates,
    thresholdIn: 1,
    adBudgetCents: 25000,
    adDays: 7,
    adGoogleSharePct: 60,
    emailEnabled: true,
    defaults: templates,
    photos,
    maxPhotos: 5,
  };
}

const photo = (id: string): StormPhoto => ({ id, url: `/api/storm/photos/${id}/file`, createdAt: '2026-10-01T00:00:00Z' });

describe('the edit sheet of an ad campaign', () => {
  it('offers the Settings photos as numbered choices, with no photo first', async () => {
    api = teamStub();
    api.routes['GET /api/storm/settings'] = () => ({ body: settingsWith([photo(PHOTO)]) });
    renderAt(<StepFieldsSheet step={adStep()} kit={adCampaignKit} saving={false} onSave={vi.fn()} onClose={vi.fn()} />);

    expect(await screen.findByRole('checkbox', { name: 'Photo 1' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'No photo' })).toBeChecked();
  });

  it('ticks the photo the step already uses', async () => {
    api = teamStub();
    api.routes['GET /api/storm/settings'] = () => ({ body: settingsWith([photo(PHOTO)]) });
    renderAt(
      <StepFieldsSheet step={adStep({ photoId: PHOTO })} kit={adCampaignKit} saving={false} onSave={vi.fn()} onClose={vi.fn()} />,
    );

    expect(await screen.findByRole('checkbox', { name: 'Photo 1' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'No photo' })).not.toBeChecked();
  });

  it('saves the photo ticked from Settings', async () => {
    api = teamStub();
    api.routes['GET /api/storm/settings'] = () => ({ body: settingsWith([photo(PHOTO)]) });
    const onSave = vi.fn();
    const { user } = renderAt(
      <StepFieldsSheet step={adStep()} kit={adCampaignKit} saving={false} onSave={onSave} onClose={vi.fn()} />,
    );

    await user.click(await screen.findByRole('checkbox', { name: 'Photo 1' }));
    await user.click(screen.getByRole('button', { name: review.save }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ photoId: PHOTO });
  });

  it('keeps a photo that Settings no longer holds, marked as gone', async () => {
    api = teamStub();
    api.routes['GET /api/storm/settings'] = () => ({ body: settingsWith([photo(PHOTO)]) });
    renderAt(
      <StepFieldsSheet step={adStep({ photoId: OTHER_PHOTO })} kit={adCampaignKit} saving={false} onSave={vi.fn()} onClose={vi.fn()} />,
    );

    expect(await screen.findByRole('checkbox', { name: 'Photo 1' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'A photo no longer in Settings' })).toBeChecked();
  });
});
