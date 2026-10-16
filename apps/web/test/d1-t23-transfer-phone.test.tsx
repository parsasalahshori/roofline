import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { errors } from '../src/copy/errors.ts';
import { frontDeskSettings } from '../src/copy/front-desk-settings.ts';
import { TransferPhone } from '../src/features/front-desk/settings/TransferPhone.tsx';
import { stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

const GET = 'GET /api/me/transfer-phone';
const PUT = 'PUT /api/me/transfer-phone';
const copy = frontDeskSettings.transferPhone;

function renderWith(view: { e164: string | null; prefill: string | null; recordingAcknowledgedAt: string | null }) {
  api = stubApi({ [GET]: () => ({ body: view }) });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  render(
    <Providers client={queryClient}>
      <TransferPhone />
    </Providers>,
  );
  return { user: userEvent.setup() };
}

const phoneField = () => screen.findByLabelText(copy.label);
const ackBox = () => screen.findByRole('checkbox', { name: copy.ack });
const saveButton = () => screen.findByRole('button', { name: copy.save });

describe('Your transfer phone: the panel', () => {
  it('is a panel named for what it is, with the help line over the field', async () => {
    renderWith({ e164: null, prefill: null, recordingAcknowledgedAt: null });
    const panel = await screen.findByRole('region', { name: copy.heading });
    expect(within(panel).getByText(copy.help)).toBeInTheDocument();
    expect(within(panel).getByLabelText(copy.label)).toBeInTheDocument();
  });

  it('shows its shape while it loads', async () => {
    renderWith({ e164: null, prefill: null, recordingAcknowledgedAt: null });
    expect(screen.getByRole('status', { name: copy.loading })).toBeInTheDocument();
    await phoneField();
  });

  it('says it could not load the number, with Try again, and Try again loads it', async () => {
    let failures = 1;
    api = stubApi({
      [GET]: () => (failures-- > 0 ? { status: 500, body: { error: 'x' } } : { body: { e164: null, prefill: null, recordingAcknowledgedAt: null } }),
    });
    const queryClient = createQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false } });
    render(
      <Providers client={queryClient}>
        <TransferPhone />
      </Providers>,
    );
    const user = userEvent.setup();

    expect(await screen.findByText(copy.loadFailed)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: errors.tryAgain }));
    expect(await phoneField()).toBeInTheDocument();
  });
});

describe('Your transfer phone: prefill', () => {
  it('shows the prefill when no transfer phone is saved yet', async () => {
    renderWith({ e164: null, prefill: '+14025551234', recordingAcknowledgedAt: null });
    expect(await phoneField()).toHaveValue('+14025551234');
  });

  it('shows the saved number, not the prefill, once one is saved', async () => {
    renderWith({ e164: '+14025559999', prefill: '+14025551234', recordingAcknowledgedAt: '2026-10-01T10:00:00.000Z' });
    expect(await phoneField()).toHaveValue('+14025559999');
  });

  it('leaves the ack box unticked even when it was acknowledged before', async () => {
    renderWith({ e164: '+14025559999', prefill: null, recordingAcknowledgedAt: '2026-10-01T10:00:00.000Z' });
    expect(await ackBox()).not.toBeChecked();
  });
});

describe('Your transfer phone: acknowledgement', () => {
  it('keeps Save disabled until the recording box is ticked, then enables it', async () => {
    const { user } = renderWith({ e164: null, prefill: '+14025551234', recordingAcknowledgedAt: null });
    const save = await saveButton();
    expect(save).toBeDisabled();

    await user.click(await ackBox());
    expect(await saveButton()).toBeEnabled();
  });
});

describe('Your transfer phone: saving', () => {
  it('normalises the typed number and sends exactly e164 with the acknowledgement', async () => {
    const { user } = renderWith({ e164: null, prefill: null, recordingAcknowledgedAt: null });
    api.routes[PUT] = () => ({ body: { e164: '+14025551234', prefill: null, recordingAcknowledgedAt: '2026-10-12T12:00:00.000Z' } });

    const field = await phoneField();
    await user.clear(field);
    await user.type(field, '(402) 555-1234');
    await user.click(await ackBox());
    await user.click(await saveButton());

    await waitFor(() => expect(api.sent(PUT)).toEqual([{ e164: '+14025551234', ackRecording: true }]));
    expect(await screen.findByText(copy.saved)).toBeInTheDocument();
    expect(await phoneField()).toHaveValue('+14025551234');
  });

  it('shows the invalid message and sends nothing for a number that is not a phone', async () => {
    const { user } = renderWith({ e164: null, prefill: null, recordingAcknowledgedAt: null });

    const field = await phoneField();
    await user.clear(field);
    await user.type(field, 'abc');
    await user.click(await ackBox());
    await user.click(await saveButton());

    expect(await screen.findByText(copy.invalid)).toBeInTheDocument();
    expect(api.count(PUT)).toBe(0);
  });

  it('shows the server message on the field when the server names the e164 field', async () => {
    const { user } = renderWith({ e164: null, prefill: '+14025551234', recordingAcknowledgedAt: null });
    api.routes[PUT] = () => ({ status: 400, body: { error: 'That number cannot take calls.', field: 'e164' } });

    await user.click(await ackBox());
    await user.click(await saveButton());

    expect(await screen.findByText('That number cannot take calls.')).toBeInTheDocument();
    expect(await phoneField()).toHaveAttribute('aria-invalid', 'true');
  });
});
