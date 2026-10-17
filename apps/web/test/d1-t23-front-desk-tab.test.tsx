import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FrontDeskSettings, FrontDeskVoice } from '@roofline/shared';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { forwarding } from '../src/copy/forwarding.ts';
import { frontDeskSettings } from '../src/copy/front-desk-settings.ts';
import { settings } from '../src/copy/settings.ts';
import { ACCOUNT, SHELL_ROUTES, stubApi } from './helpers.tsx';

vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return { MapView: () => createElement('div', { 'data-map-mock': true }) };
});

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

const COMPANY_BODY = {
  id: 'c1',
  name: 'Summit Roofing',
  slug: 'summit-roofing',
  status: 'active',
  legalName: null,
  phone: '+14025551234',
  email: 'office@summit.example',
  website: 'https://summit.example',
  addressStreet: '12 Main St',
  addressCity: 'Omaha',
  addressState: 'NE',
  addressZip: '68102',
  timezone: 'America/Chicago',
  logoUrl: null,
};

const SETUP_VIEW = {
  items: [{ key: 'company_basics', status: 'todo', comingWith: null, skippable: false, data: {} }],
  progress: { done: 0, total: 5 },
} as const;

const VOICES: FrontDeskVoice[] = [
  { id: 'maya', label: 'Warm', previewUrl: 'https://cdn.example/warm.mp3' },
  { id: 'claire', label: 'Plain', previewUrl: null },
];

function makeSettings(overrides: Partial<FrontDeskSettings> = {}): FrontDeskSettings {
  return {
    enabled: false,
    blockedReason: null,
    texts: true,
    voice: 'maya',
    facts: 'We are open weekdays.',
    canMove: true,
    canCancel: false,
    ringTeamFirstSeconds: 10,
    missedCallTextBack: true,
    recordingRetentionDays: 90,
    transcriptRetentionDays: 365,
    maxConcurrentAiCalls: 3,
    forwardingVerifiedAt: null,
    onCall: [
      { userId: 'u2', name: 'Pat Lead', onCallOrder: 2, transferPhoneE164: '+14025550102', recordingAcknowledged: true },
      { userId: 'u1', name: 'Sam Roofer', onCallOrder: 1, transferPhoneE164: null, recordingAcknowledged: false },
      { userId: 'u3', name: 'Lee Off', onCallOrder: null, transferPhoneE164: null, recordingAcknowledged: false },
    ],
    ...overrides,
  };
}

const TEXTING_VIEW = { state: 'approved', reason: null, rejectedFields: [], brand: null, defaults: {}, submittedAt: null, approvedAt: '2026-10-01T10:00:00.000Z', number: '+14025550100', needsPaymentMethod: false, needsVerifiedEmail: false, hostedPolicyUrls: { privacy: 'https://example.test/privacy', terms: 'https://example.test/terms' } };

function signIn(current: FrontDeskSettings, extra: Record<string, () => { status?: number; body?: unknown }> = {}) {
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role: 'owner' } }),
    'GET /api/company': () => ({ body: COMPANY_BODY }),
    'GET /api/team': () => ({ body: { members: [], invites: [] } }),
    'GET /api/setup': () => ({ body: SETUP_VIEW }),
    'GET /api/front-desk/settings': () => ({ body: current }),
    'GET /api/front-desk/voices': () => ({ body: VOICES }),
    'GET /api/texting': () => ({ body: TEXTING_VIEW }),
    ...extra,
  });
}

function renderTab() {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries: ['/settings/front-desk'] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, user: userEvent.setup() };
}

const SAVE = 'PUT /api/front-desk/settings';
const saveButton = () => screen.findByRole('button', { name: frontDeskSettings.save });
const saveBar = () => screen.queryByRole('group', { name: settings.saveBar.label });
const textsSwitch = () => screen.findByRole('switch', { name: frontDeskSettings.texts.label });

describe('Settings -> Front Desk form', () => {
  it('shows the blocked sentence when forwarding is not verified; the owner may still turn it on after a confirm', async () => {
    signIn(makeSettings({ blockedReason: 'forwarding_not_verified' }));
    const { user } = renderTab();

    const toggle = await screen.findByRole('switch', { name: frontDeskSettings.onOff.label });
    expect(screen.getByText(frontDeskSettings.onOff.blocked.forwarding_not_verified)).toBeInTheDocument();
    await waitFor(() => expect(toggle).toBeEnabled());
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(frontDeskSettings.onOff.overrideConfirm)).toBeInTheDocument();
  });

  it('enables the switch when nothing blocks it', async () => {
    signIn(makeSettings({ blockedReason: null }));
    renderTab();

    const toggle = await screen.findByRole('switch', { name: frontDeskSettings.onOff.label });
    expect(toggle).toBeEnabled();
    expect(screen.queryByText(frontDeskSettings.onOff.blocked.forwarding_not_verified)).not.toBeInTheDocument();
    expect(screen.queryByText(frontDeskSettings.onOff.blocked.no_number)).not.toBeInTheDocument();
  });

  it('counts facts as they are typed and refuses a save when they are too long', async () => {
    signIn(makeSettings({ facts: '' }));
    const { user } = renderTab();

    const facts = await screen.findByLabelText(frontDeskSettings.facts.label);
    expect(screen.getByText(frontDeskSettings.facts.counter(0, 2000))).toBeInTheDocument();

    await user.type(facts, 'Hours are nine to five.');
    expect(screen.getByText(frontDeskSettings.facts.counter(23, 2000))).toBeInTheDocument();

    // Paste-sized text over the limit, set in one change
    fireEvent.change(facts, { target: { value: 'x'.repeat(2001) } });
    expect(screen.getByText(frontDeskSettings.facts.counter(2001, 2000))).toBeInTheDocument();
    expect(screen.getByText(frontDeskSettings.facts.tooLong(2000))).toBeInTheDocument();

    await user.click(await saveButton());
    expect(api.count(SAVE)).toBe(0);
  });

  it('says what each retention setting clears and keeps (Ruling BI)', async () => {
    signIn(makeSettings());
    renderTab();
    await screen.findByLabelText(frontDeskSettings.transcriptDays.label);
    expect(screen.getByText(frontDeskSettings.transcriptDays.help)).toBeInTheDocument();
    expect(screen.getByText(frontDeskSettings.recordingDays.help)).toBeInTheDocument();
    expect(frontDeskSettings.transcriptDays.help).toMatch(/STOP, START and HELP/);
    expect(frontDeskSettings.recordingDays.help).toMatch(/deletes the ones already saved/);
  });

  it('shows range errors on the number fields and sends nothing', async () => {
    signIn(makeSettings());
    const { user } = renderTab();

    const ring = await screen.findByLabelText(frontDeskSettings.ringTeam.label);
    await user.clear(ring);
    await user.type(ring, '31');
    expect(screen.getByText(frontDeskSettings.ringTeam.range(0, 30))).toBeInTheDocument();

    const calls = screen.getByLabelText(frontDeskSettings.maxCalls.label);
    await user.clear(calls);
    await user.type(calls, '0');
    expect(screen.getByText(frontDeskSettings.maxCalls.range(1, 10))).toBeInTheDocument();

    const transcripts = screen.getByLabelText(frontDeskSettings.transcriptDays.label);
    await user.clear(transcripts);
    await user.type(transcripts, '29');
    expect(screen.getByText(frontDeskSettings.transcriptDays.range(30, 730))).toBeInTheDocument();

    await user.click(await saveButton());
    expect(api.count(SAVE)).toBe(0);
  });

  it('plays a preview only for a voice that has one', async () => {
    signIn(makeSettings({ voice: 'maya' }));
    const { user } = renderTab();

    const preview = frontDeskSettings.voice.preview('Warm');
    await waitFor(() => expect(screen.getByLabelText(preview)).toBeInTheDocument());
    expect(screen.getByLabelText(preview).tagName).toBe('AUDIO');
    expect(screen.getByLabelText(preview)).toHaveAttribute('src', 'https://cdn.example/warm.mp3');

    await user.click(screen.getByLabelText(frontDeskSettings.voice.label));
    await user.click(await screen.findByRole('option', { name: 'Plain' }));
    await waitFor(() => expect(screen.queryByLabelText(preview)).not.toBeInTheDocument());
    expect(screen.queryByLabelText(frontDeskSettings.voice.preview('Plain'))).not.toBeInTheDocument();
    expect(document.querySelector('audio')).toBeNull();
  });

  it('saves exactly the settings input, with the on-call order', async () => {
    signIn(makeSettings(), { [SAVE]: () => ({ body: makeSettings({ enabled: false, texts: false }) }) });
    const { user } = renderTab();

    await user.click(await textsSwitch());
    await user.click(await saveButton());
    await waitFor(() => expect(api.count(SAVE)).toBe(1));
    const [body] = api.sent(SAVE) as Record<string, unknown>[];
    expect(Object.keys(body).sort()).toEqual(
      [
        'enabled',
        'texts',
        'voice',
        'facts',
        'canMove',
        'canCancel',
        'ringTeamFirstSeconds',
        'missedCallTextBack',
        'recordingRetentionDays',
        'transcriptRetentionDays',
        'maxConcurrentAiCalls',
        'onCallOrder',
      ].sort(),
    );
    expect(body).toMatchObject({
      enabled: false,
      texts: false,
      voice: 'maya',
      ringTeamFirstSeconds: 10,
      maxConcurrentAiCalls: 3,
      onCallOrder: ['u1', 'u2'],
    });
    expect(await screen.findByText(frontDeskSettings.saved)).toBeInTheDocument();
  });

  it('shows a field error from the server on that field', async () => {
    signIn(makeSettings(), {
      [SAVE]: () => ({ status: 400, body: { error: 'Facts are too long.', field: 'facts' } }),
    });
    const { user } = renderTab();

    const facts = await screen.findByLabelText(frontDeskSettings.facts.label);
    await user.type(facts, ' Closed on Sundays.');
    await user.click(await saveButton());
    await waitFor(() => expect(facts).toHaveAccessibleDescription(expect.stringContaining('Facts are too long.')));
    expect(within(facts.closest('div') as HTMLElement).getByText('Facts are too long.')).toBeInTheDocument();
  });

  it('shows the forwarding guide in the slot below the form', async () => {
    signIn(makeSettings());
    renderTab();

    await screen.findByRole('switch', { name: frontDeskSettings.onOff.label });
    const slot = document.querySelector('[data-forwarding-slot]') as HTMLElement;
    expect(slot).not.toBeNull();
    expect(await within(slot).findByRole('heading', { name: forwarding.title })).toBeInTheDocument();
  });
});

describe('Settings -> Front Desk panels and save bar', () => {
  it('lays the form out as panels, each named by its heading, with the on-call list and the forwarding guide as panels too', async () => {
    signIn(makeSettings());
    renderTab();

    await screen.findByRole('switch', { name: frontDeskSettings.onOff.label });
    for (const name of [
      frontDeskSettings.panels.answering,
      frontDeskSettings.panels.assistant,
      frontDeskSettings.panels.rules,
      frontDeskSettings.panels.timing,
      frontDeskSettings.onCall.heading,
    ]) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
    expect(await screen.findByRole('region', { name: forwarding.title })).toBeInTheDocument();
  });

  it('shows no save bar until something changes, and Discard puts every field back', async () => {
    signIn(makeSettings());
    const { user } = renderTab();

    const texts = await textsSwitch();
    expect(saveBar()).toBeNull();

    await user.click(texts);
    expect(texts).toHaveAttribute('aria-checked', 'false');
    expect(saveBar()).not.toBeNull();

    const ring = screen.getByLabelText(frontDeskSettings.ringTeam.label);
    await user.clear(ring);
    await user.type(ring, '12');

    await user.click(screen.getByRole('button', { name: settings.saveBar.discard }));
    expect(saveBar()).toBeNull();
    expect(texts).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText(frontDeskSettings.ringTeam.label)).toHaveValue(10);
    expect(api.count(SAVE)).toBe(0);
  });

  it('counts a change to the on-call order as something to save', async () => {
    signIn(makeSettings());
    const { user } = renderTab();

    await screen.findByRole('switch', { name: frontDeskSettings.onOff.label });
    expect(saveBar()).toBeNull();
    await user.click(await screen.findByRole('button', { name: frontDeskSettings.onCall.moveDown('Sam Roofer') }));
    expect(saveBar()).not.toBeNull();
  });

  it('keeps the save button shut while a number is out of range, and opens it again when the number is fixed', async () => {
    signIn(makeSettings());
    const { user } = renderTab();

    const calls = await screen.findByLabelText(frontDeskSettings.maxCalls.label);
    await user.clear(calls);
    await user.type(calls, '0');
    expect(await saveButton()).toBeDisabled();

    await user.clear(calls);
    await user.type(calls, '4');
    expect(await saveButton()).toBeEnabled();
  });
});
