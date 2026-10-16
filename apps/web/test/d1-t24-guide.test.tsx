import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { forwardingSteps, type Carrier } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forwarding } from '../src/copy/forwarding.ts';
import { ForwardingGuide } from '../src/features/front-desk/settings/ForwardingGuide.tsx';
import { renderAt, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

const TEXTING = 'GET /api/texting';
const COMPANY_GET = 'GET /api/company';
const ROOFLINE = '+14025550100';
const BUSINESS = '+14025551234';

const TEXTING_VIEW = {
  state: 'approved',
  reason: null,
  rejectedFields: [],
  brand: null,
  defaults: {},
  submittedAt: null,
  approvedAt: '2026-10-01T10:00:00.000Z',
  number: ROOFLINE,
  needsPaymentMethod: false,
  needsVerifiedEmail: false,
  hostedPolicyUrls: { privacy: 'https://example.test/privacy', terms: 'https://example.test/terms' },
};

const COMPANY_BODY = {
  id: 'c1',
  name: 'Summit Roofing',
  slug: 'summit-roofing',
  status: 'active',
  legalName: null,
  phone: BUSINESS,
  email: 'office@summit.example',
  website: null,
  addressStreet: null,
  addressCity: null,
  addressState: null,
  addressZip: null,
  timezone: 'America/Chicago',
  logoUrl: null,
};

function renderGuide({
  number = ROOFLINE,
  phone = BUSINESS,
  path = '/settings/front-desk',
}: { number?: string | null; phone?: string | null; path?: string } = {}) {
  api = stubApi({
    [TEXTING]: () => ({ body: { ...TEXTING_VIEW, number } }),
    [COMPANY_GET]: () => ({ body: { ...COMPANY_BODY, phone } }),
  });
  const { user } = renderAt(<ForwardingGuide />, path);
  return { user };
}

const carrierPicker = () => screen.findByLabelText(forwarding.carrierLabel);
const modePicker = () => screen.findByLabelText(forwarding.modeLabel);

/** Opens the pick-one control with this label and picks the option with these words. */
async function choose(user: ReturnType<typeof userEvent.setup>, picker: HTMLElement, option: string) {
  await user.click(picker);
  await user.click(await screen.findByRole('option', { name: option }));
}

async function pick(user: ReturnType<typeof userEvent.setup>, carrier: Carrier) {
  await choose(user, await carrierPicker(), forwarding.carriers[carrier]);
}

describe('forwarding guide: dial codes', () => {
  it('shows the Verizon all-calls code and the off code', async () => {
    renderGuide();
    expect(await screen.findByText('*724025550100')).toBeInTheDocument();
    expect(screen.getByText('*73')).toBeInTheDocument();
    expect(screen.getByText(forwarding.codesOnLabel)).toBeInTheDocument();
    expect(screen.getByText(forwarding.codesOffLabel)).toBeInTheDocument();
  });

  it('switches to the no-answer code when the mode changes', async () => {
    const { user } = renderGuide();
    await screen.findByText('*724025550100');
    await choose(user, await modePicker(), forwarding.modes.no_answer);
    expect(await screen.findByText('*714025550100')).toBeInTheDocument();
    expect(screen.queryByText('*724025550100')).not.toBeInTheDocument();
  });

  it('shows the AT&T codes', async () => {
    const { user } = renderGuide();
    await screen.findByText('*724025550100');
    await pick(user, 'att');
    expect(await screen.findByText('**21*4025550100#')).toBeInTheDocument();
    expect(screen.getByText('##21#')).toBeInTheDocument();
  });
});

describe('forwarding guide: the panel', () => {
  it('is a region named for what it does, with the two numbers as labelled tiles and the pickers as pick-one lists', async () => {
    renderGuide();
    const guide = await screen.findByRole('region', { name: forwarding.title });
    await screen.findByText('*724025550100');
    expect(within(guide).getByText(forwarding.businessNumberLabel)).toBeInTheDocument();
    expect(within(guide).getByText(forwarding.rooflineNumberLabel)).toBeInTheDocument();
    expect(within(guide).getByText(ROOFLINE)).toBeInTheDocument();
    for (const label of [forwarding.carrierLabel, forwarding.modeLabel]) {
      expect(within(guide).getByLabelText(label)).toHaveAttribute('aria-haspopup', 'listbox');
    }
    expect(within(guide).getByLabelText(forwarding.carrierLabel)).toHaveTextContent(forwarding.carriers.verizon);
    expect(within(guide).getByLabelText(forwarding.modeLabel)).toHaveTextContent(forwarding.modes.all);
  });

  it('offers every phone company in its list', async () => {
    const { user } = renderGuide();
    await user.click(await carrierPicker());
    const options = within(await screen.findByRole('listbox', { name: forwarding.carrierLabel })).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(Object.values(forwarding.carriers));
  });

  it('says it could not load the numbers, with Try again', async () => {
    api = stubApi({
      [TEXTING]: () => ({ status: 500, body: { error: 'x' } }),
      [COMPANY_GET]: () => ({ body: COMPANY_BODY }),
    });
    renderAt(<ForwardingGuide />, '/settings/front-desk');
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('forwarding guide: VoIP steps', () => {
  it('renders the steps as ordered lists with the strings from forwardingSteps', async () => {
    const { user } = renderGuide();
    await screen.findByText('*724025550100');
    await pick(user, 'ringcentral');

    const expected = forwardingSteps('ringcentral', 'all', ROOFLINE);
    expect(expected.kind).toBe('steps');

    const lists = await screen.findAllByRole('list');
    expect(lists).toHaveLength(2);
    expect(lists[0].tagName).toBe('OL');
    const onItems = within(lists[0]).getAllByRole('listitem').map((item) => item.textContent);
    expect(onItems).toEqual(expected.on);
    const offItems = within(lists[1]).getAllByRole('listitem').map((item) => item.textContent);
    expect(offItems).toEqual(expected.off);
    expect(screen.queryByText('*724025550100')).not.toBeInTheDocument();
  });
});

describe('forwarding guide: copy', () => {
  it('copies a code to the clipboard and says so', async () => {
    const { user } = renderGuide();
    await screen.findByText('*724025550100');
    // Stubbed after render: userEvent.setup() installs its own navigator.clipboard
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    const buttons = screen.getAllByRole('button', { name: forwarding.copy });
    await user.click(buttons[0]);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('*724025550100'));
    expect(await screen.findByRole('button', { name: forwarding.copied })).toBeInTheDocument();
  });
});

describe('forwarding guide: missing numbers', () => {
  it('shows the not-ready notice and no code when the Roofline number is null', async () => {
    renderGuide({ number: null });
    expect(await screen.findByText(forwarding.noNumberYet)).toBeInTheDocument();
    expect(screen.queryByText(/^\*7/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: forwarding.copy })).not.toBeInTheDocument();
  });

  it('shows the business-number hint and still shows codes when the business phone is null', async () => {
    renderGuide({ phone: null });
    expect(await screen.findByText(forwarding.noBusinessNumber)).toBeInTheDocument();
    expect(screen.getByText('*724025550100')).toBeInTheDocument();
  });
});

describe('forwarding guide: anchor', () => {
  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('scrolls the guide into view when the URL has the #forwarding hash', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderGuide({ path: '/settings/front-desk#forwarding' });
    await screen.findByRole('heading', { name: forwarding.title });
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(scroll.mock.contexts[0]).toBe(document.getElementById('forwarding'));
  });

  it('does not scroll when the URL has no hash', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderGuide({ path: '/settings/front-desk' });
    await screen.findByRole('heading', { name: forwarding.title });
    expect(scroll).not.toHaveBeenCalled();
  });
});
