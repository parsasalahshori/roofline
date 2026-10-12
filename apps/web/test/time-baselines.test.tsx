import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentPage, timeBaselines as copy } from '../src/copy/agents.ts';
import { TimeBaselines } from '../src/features/agents/TimeBaselines.tsx';
import { renderAt, stubApi } from './helpers.tsx';

const ROWS = [
  { key: 'text_sent', unit: 'text', basis: 'Each text counts for a short time', defaultMinutes: 2, minutes: 2, capMinutes: null, perCallLength: false },
  { key: 'proposal_sent', unit: 'proposal', basis: 'Each proposal takes a while', defaultMinutes: 20, minutes: 25, capMinutes: null, perCallLength: false },
  { key: 'call_answered', unit: 'call', basis: 'Each answered call', defaultMinutes: 2, minutes: 2, capMinutes: null, perCallLength: true },
  { key: 'route_built', unit: 'route', basis: 'Each route planned', defaultMinutes: 15, minutes: 15, capMinutes: 120, perCallLength: false },
];

function setup(canEdit = true) {
  const api = stubApi({
    'GET /api/agents/time-baselines': () => ({ body: { rows: ROWS, canEdit, hourlyRateCents: 2800 } }),
    'PUT /api/agents/time-baselines': () => ({ body: { rows: ROWS, canEdit, hourlyRateCents: 2800 } }),
  });
  const view = renderAt(<TimeBaselines />, '/settings/agents');
  return { api, ...view };
}
const input = async (key: keyof typeof agentPage.baselineLabels) =>
  (await screen.findByLabelText(`${copy.inputLabelPrefix} ${agentPage.baselineLabels[key]}`)) as HTMLInputElement;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TimeBaselines', () => {
  it('owner edits one number and Save sends only that key', async () => {
    const { api, user } = setup();
    const field = await input('text_sent');
    await user.clear(field);
    await user.type(field, '3');
    await user.click(screen.getByRole('button', { name: copy.save }));
    expect(await screen.findByText(copy.saved)).toBeInTheDocument();
    expect(api.sent('PUT /api/agents/time-baselines')).toEqual([{ minutes: { text_sent: 3 } }]);
    expect(api.unexpected).toEqual([]);
  });

  it('Reset to default sends null for a changed company number', async () => {
    const { api, user } = setup();
    const field = await input('proposal_sent');
    expect(screen.getAllByRole('button', { name: new RegExp(copy.reset) })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: `${copy.reset} ${copy.resetLabelSuffix} ${agentPage.baselineLabels.proposal_sent}` }));
    expect(field.value).toBe('20');
    await user.click(screen.getByRole('button', { name: copy.save }));
    await waitFor(() => expect(api.sent('PUT /api/agents/time-baselines')).toEqual([{ minutes: { proposal_sent: null } }]));
    expect(api.unexpected).toEqual([]);
  });

  it('validation shows plain messages next to the input and blocks Save', async () => {
    const { api, user } = setup();
    const field = await input('text_sent');
    const save = screen.getByRole('button', { name: copy.save });
    await user.clear(field);
    await user.type(field, '700');
    const described = document.getElementById(field.getAttribute('aria-describedby') ?? '');
    expect(described).toHaveTextContent(copy.errorRange);
    expect(save).toBeDisabled();
    await user.clear(field);
    await user.type(field, '2.3');
    expect(screen.getByText(copy.errorStep)).toBeInTheDocument();
    await user.clear(field);
    expect(screen.getByText(copy.errorNotNumber)).toBeInTheDocument();
    expect(save).toBeDisabled();
    expect(api.calls.filter((call) => call.key.startsWith('PUT'))).toEqual([]);
    expect(api.unexpected).toEqual([]);
  });

  it('office sees read-only text', async () => {
    const { api } = setup(false);
    expect(await screen.findByText(copy.ownerOnly)).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByRole('button', { name: copy.save })).toBeNull();
    expect(screen.getByText(`25 ${copy.minutesSuffix}`)).toBeInTheDocument();
    expect(api.unexpected).toEqual([]);
  });

  it('caps and call length are in words', async () => {
    const { api } = setup();
    await input('text_sent');
    expect(screen.getByText(new RegExp(`${copy.capPrefix} 120 ${copy.capSuffix}`))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(copy.plusCallLength))).toBeInTheDocument();
    expect(api.unexpected).toEqual([]);
  });

  it('shows onlyFinished line and the hourly rate with a link to /settings/company', async () => {
    const { api } = setup();
    expect(await screen.findByText(copy.onlyFinished)).toBeInTheDocument();
    const rate = screen.getByText(`${copy.ratePrefix} $28 ${copy.rateSuffix}`, { exact: false });
    expect(rate).toBeInTheDocument();
    expect(within(rate.parentElement ?? rate).getByRole('link', { name: copy.rateLinkText })).toHaveAttribute('href', '/settings/company');
    expect(api.unexpected).toEqual([]);
  });

  it('the rate link shows only for the owner', async () => {
    const { api } = setup();
    expect(await screen.findByRole('link', { name: copy.rateLinkText })).toHaveAttribute('href', '/settings/company');
    cleanup();
    setup(false);
    expect(await screen.findByText(copy.ownerOnly)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: copy.rateLinkText })).toBeNull();
    expect(screen.getByText(`${copy.ratePrefix} $28 ${copy.rateSuffix}`)).toBeInTheDocument();
    expect(api.unexpected).toEqual([]);
  });
});
