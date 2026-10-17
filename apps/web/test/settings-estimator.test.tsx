import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { DEFAULT_TIER_TEMPLATES, TierTemplateSchema, type SetupItemView, type TierTemplate } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setup } from '../src/copy/setup.ts';
import { settings as settingsCopy } from '../src/copy/settings.ts';
import { tiers } from '../src/copy/tiers.ts';
import { proposals } from '../src/copy/proposals.ts';
import { tierEditor } from '../src/copy/tiersEditor.ts';
import { estimateCopy, financeCopy } from '../src/copy/financeEstimate.ts';
import type { EstimatorSettings } from '@roofline/shared';
import { SetupRow } from '../src/features/setup/SetupRow.tsx';
import { EstimateSection } from '../src/features/settings/EstimateSection.tsx';
import { FinancingSection } from '../src/features/settings/FinancingSection.tsx';
import { TiersSection } from '../src/features/settings/TiersSection.tsx';
import { ACCOUNT, renderAt, type Routes, SHELL_ROUTES, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

const TIERS_GET = 'GET /api/tier-templates';
const TIERS_PUT = 'PUT /api/tier-templates';
const SETTINGS_GET = 'GET /api/estimator/settings';
const SETTINGS_PUT = 'PUT /api/estimator/settings';

/** Fresh copies of the three defaults, good, better, best. */
function templatesBody(): { templates: TierTemplate[] } {
  return { templates: DEFAULT_TIER_TEMPLATES.map((t) => structuredClone(t)) };
}

/** Estimator settings as the API answers them, with some overrides. */
function settingsBody(overrides: Partial<EstimatorSettings> = {}): EstimatorSettings {
  return {
    defaultPitchX12: 6,
    overhangFt: 1,
    proposalValidDays: 30,
    aerialMeasure: false,
    aerialConfigured: false,
    estimateChangeClause: true,
    financingAprBps: null,
    financingTermMonths: null,
    ...overrides,
  };
}

/** The owner by default; office for the read-only tests. Each test may add its own routes. */
function settingsApi(role: 'owner' | 'office' = 'owner', overrides: Routes = {}, estimator: Partial<EstimatorSettings> = {}) {
  const account = role === 'owner' ? ACCOUNT : { ...ACCOUNT, role: 'office' as const };
  const current = settingsBody(estimator);
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: account }),
    [TIERS_GET]: () => ({ body: templatesBody() }),
    [TIERS_PUT]: ({ body }) => ({ body }),
    [SETTINGS_GET]: () => ({ body: current }),
    [SETTINGS_PUT]: ({ body }) => ({ body: { ...current, ...(body as object) } }),
    ...overrides,
  });
  return api;
}

/** One Good, Better, Best option's region, by its accessible name. */
async function tierRegion(tier: 'good' | 'better' | 'best') {
  return screen.findByRole('region', { name: tierEditor.regionLabels[tier] });
}

describe('Settings Prices: Good, Better, Best templates', () => {
  it('tier save sends the shared schema shape', async () => {
    settingsApi();
    const { user } = renderAt(<TiersSection />, '/settings/prices');

    const good = await tierRegion('good');
    const name = await within(good).findByLabelText(proposals.fieldName);
    await user.clear(name);
    await user.type(name, 'Good, new name');
    await user.click(screen.getByRole('button', { name: tiers.save }));

    await waitFor(() => expect(api.count(TIERS_PUT)).toBe(1));
    const sent = api.calls.find((call) => call.key === TIERS_PUT)?.body as { templates: unknown[] };
    expect(Object.keys(sent)).toEqual(['templates']);
    expect(sent.templates).toHaveLength(3);
    for (const template of sent.templates) {
      expect(TierTemplateSchema.safeParse(template).success).toBe(true);
    }
    const parsed = sent.templates.map((template) => TierTemplateSchema.parse(template));
    expect(parsed.find((template) => template.tier === 'good')?.name).toBe('Good, new name');
  });

  it('tier validation errors appear by field path', async () => {
    settingsApi();
    const { user } = renderAt(<TiersSection />, '/settings/prices');

    const good = await tierRegion('good');
    const name = await within(good).findByLabelText(proposals.fieldName);
    await user.clear(name);
    const waste = within(good).getByLabelText(proposals.fieldWaste);
    await user.clear(waste);
    await user.type(waste, '51');
    await user.click(screen.getByRole('button', { name: tiers.save }));

    expect(await within(good).findByText(tierEditor.errors.name)).toBeInTheDocument();
    expect(within(good).getByText(tierEditor.errors.waste)).toBeInTheDocument();
    expect(api.count(TIERS_PUT)).toBe(0);
  });

  it('tiers are read-only for office', async () => {
    settingsApi('office');
    renderAt(<TiersSection />, '/settings/prices');

    const name = await within(await tierRegion('good')).findByLabelText(proposals.fieldName);
    expect(name).toBeDisabled();
    expect(screen.queryByRole('button', { name: tiers.save })).toBeNull();
  });
});

describe('Settings Prices: financing', () => {
  it('financing save sends apr in basis points and term', async () => {
    settingsApi();
    const { user } = renderAt(<FinancingSection />, '/settings/prices');

    const apr = await screen.findByLabelText(financeCopy.aprLabel);
    await user.type(apr, '9.99');
    const term = screen.getByLabelText(financeCopy.termLabel);
    await user.type(term, '120');
    await user.click(screen.getByRole('button', { name: tiers.save }));

    await waitFor(() => expect(api.count(SETTINGS_PUT)).toBe(1));
    expect(api.sent(SETTINGS_PUT)[0]).toEqual({ financingAprBps: 999, financingTermMonths: 120 });
  });

  it('financing refuses what the API refuses: APR over 50, term over 360', async () => {
    settingsApi();
    const { user } = renderAt(<FinancingSection />, '/settings/prices');

    await user.type(await screen.findByLabelText(financeCopy.aprLabel), '60');
    await user.type(screen.getByLabelText(financeCopy.termLabel), '480');
    await user.click(screen.getByRole('button', { name: tiers.save }));

    expect(await screen.findByText(financeCopy.aprRange)).toBeInTheDocument();
    expect(screen.getByText(financeCopy.termRange)).toBeInTheDocument();
    expect(financeCopy.aprRange).toContain('50');
    expect(financeCopy.termRange).toContain('360');
    expect(api.count(SETTINGS_PUT)).toBe(0);
  });

  it('financing needs both or neither', async () => {
    settingsApi();
    const { user } = renderAt(<FinancingSection />, '/settings/prices');

    const apr = await screen.findByLabelText(financeCopy.aprLabel);
    await user.type(apr, '6.5');
    await user.click(screen.getByRole('button', { name: tiers.save }));

    expect(await screen.findByText(financeCopy.pairRequired)).toBeInTheDocument();
    expect(api.count(SETTINGS_PUT)).toBe(0);
  });
});

describe('Settings Prices: estimate settings', () => {
  it('estimate save sends the settings', async () => {
    settingsApi();
    const { user } = renderAt(<EstimateSection />, '/settings/prices');

    const validDays = await screen.findByLabelText(estimateCopy.validDays);
    await user.clear(validDays);
    await user.type(validDays, '45');
    const overhang = screen.getByLabelText(estimateCopy.overhang);
    await user.clear(overhang);
    await user.type(overhang, '1.5');
    const pitch = screen.getByLabelText(estimateCopy.defaultPitch);
    await user.clear(pitch);
    await user.type(pitch, '7');
    await user.click(screen.getByRole('button', { name: tiers.save }));

    await waitFor(() => expect(api.count(SETTINGS_PUT)).toBe(1));
    expect(api.sent(SETTINGS_PUT)[0]).toEqual({
      defaultPitchX12: 7,
      overhangFt: 1.5,
      proposalValidDays: 45,
      estimateChangeClause: true,
    });
  });

  it('estimate rejects 181 valid days', async () => {
    settingsApi();
    const { user } = renderAt(<EstimateSection />, '/settings/prices');

    const validDays = await screen.findByLabelText(estimateCopy.validDays);
    await user.clear(validDays);
    await user.type(validDays, '181');
    await user.click(screen.getByRole('button', { name: tiers.save }));

    expect(await screen.findByText(estimateCopy.validDaysRange)).toBeInTheDocument();
    expect(api.count(SETTINGS_PUT)).toBe(0);
  });

  it('estimate is read-only for office', async () => {
    settingsApi('office');
    renderAt(<EstimateSection />, '/settings/prices');

    expect(await screen.findByLabelText(estimateCopy.validDays)).toBeDisabled();
    expect(screen.getByLabelText(estimateCopy.overhang)).toBeDisabled();
    expect(screen.getByLabelText(estimateCopy.defaultPitch)).toBeDisabled();
    expect(screen.queryByRole('button', { name: tiers.save })).toBeNull();
  });

  it('aerial switch is hidden when not configured', async () => {
    settingsApi('owner', {}, { aerialConfigured: false });
    renderAt(<EstimateSection />, '/settings/prices');

    await screen.findByLabelText(estimateCopy.validDays);
    expect(screen.queryByRole('switch', { name: estimateCopy.aerial })).toBeNull();
  });

  it('aerial switch is shown when configured and sends aerialMeasure on save', async () => {
    settingsApi('owner', {}, { aerialConfigured: true });
    const { user } = renderAt(<EstimateSection />, '/settings/prices');

    const aerial = await screen.findByRole('switch', { name: estimateCopy.aerial });
    await user.click(aerial);
    await user.click(screen.getByRole('button', { name: tiers.save }));

    await waitFor(() => expect(api.count(SETTINGS_PUT)).toBe(1));
    expect(api.sent(SETTINGS_PUT)[0]).toMatchObject({ aerialMeasure: true });
  });
});

describe('Settings Setup: prices row', () => {
  it('setup row links to prices', async () => {
    api = stubApi({});
    const item: SetupItemView = { key: 'prices_and_tiers', status: 'todo', comingWith: null, skippable: false, data: {} };
    renderAt(
      <ul>
        <SetupRow item={item} canAct />
      </ul>,
      '/settings/setup',
    );

    const link = await screen.findByRole('link', { name: setup.actions.setPrices });
    expect(link).toHaveAttribute('href', '/settings/prices');
  });
});

describe('Settings Prices: the save bar', () => {
  const bar = () => screen.queryByRole('group', { name: settingsCopy.saveBar.label });

  it('Good, Better, Best: the bar waits for a change, and Discard puts the templates back', async () => {
    settingsApi();
    const { user } = renderAt(<TiersSection />, '/settings/prices');

    const good = await tierRegion('good');
    const name = await within(good).findByLabelText(proposals.fieldName);
    const before = (name as HTMLInputElement).value;
    expect(bar()).toBeNull();
    expect(screen.queryByRole('button', { name: tiers.save })).toBeNull();

    await user.type(name, ' plus');
    expect(bar()).not.toBeNull();
    await user.click(within(bar() as HTMLElement).getByRole('button', { name: settingsCopy.saveBar.discard }));

    expect(within(await tierRegion('good')).getByLabelText(proposals.fieldName)).toHaveValue(before);
    expect(bar()).toBeNull();
    expect(api.count(TIERS_PUT)).toBe(0);
  });

  it('Good, Better, Best: a saved change leaves nothing to save', async () => {
    settingsApi();
    const { user } = renderAt(<TiersSection />, '/settings/prices');

    const name = await within(await tierRegion('good')).findByLabelText(proposals.fieldName);
    await user.type(name, ' plus');
    await user.click(screen.getByRole('button', { name: tiers.save }));

    await waitFor(() => expect(api.count(TIERS_PUT)).toBe(1));
    await waitFor(() => expect(bar()).toBeNull());
  });

  it('Financing: the bar waits for a change, and Discard empties what was typed', async () => {
    settingsApi();
    const { user } = renderAt(<FinancingSection />, '/settings/prices');

    const apr = await screen.findByLabelText(financeCopy.aprLabel);
    expect(bar()).toBeNull();
    await user.type(apr, '9.99');
    await user.click(within(bar() as HTMLElement).getByRole('button', { name: settingsCopy.saveBar.discard }));

    expect(screen.getByLabelText(financeCopy.aprLabel)).toHaveValue(null);
    expect(bar()).toBeNull();
  });

  it('Estimates: the bar waits for a change, and goes once it is saved', async () => {
    settingsApi();
    const { user } = renderAt(<EstimateSection />, '/settings/prices');

    const days = await screen.findByLabelText(estimateCopy.validDays);
    expect(bar()).toBeNull();
    await user.clear(days);
    await user.type(days, '45');
    expect(bar()).not.toBeNull();
    await user.click(screen.getByRole('button', { name: tiers.save }));

    await waitFor(() => expect(api.count(SETTINGS_PUT)).toBe(1));
    await waitFor(() => expect(bar()).toBeNull());
    expect(screen.getByLabelText(estimateCopy.validDays)).toHaveValue(45);
  });
});
