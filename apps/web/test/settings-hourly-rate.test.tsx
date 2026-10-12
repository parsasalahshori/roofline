import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../src/copy/settings.ts';
import { CompanyTab } from '../src/features/settings/CompanyTab.tsx';
import type { CompanyBody } from '../src/api/types.ts';
import { ACCOUNT, renderAt, stubApi } from './helpers.tsx';

const COMPANY: CompanyBody = {
  id: 'c1',
  name: 'Summit Roofing',
  slug: 'summit-roofing',
  status: 'active',
  legalName: null,
  phone: null,
  email: null,
  website: null,
  addressStreet: null,
  addressCity: null,
  addressState: null,
  addressZip: null,
  timezone: 'America/Chicago',
  logoUrl: null,
  located: false,
  serviceAreaMiles: null,
};

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

const rate = settings.company.hourlyRate;
const save = () => screen.getByRole('button', { name: rate.save });

function ownerApi() {
  api = stubApi({
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/company': () => ({ body: COMPANY }),
    'GET /api/company/settings': () => ({ body: { hourlyRateCents: 2800 } }),
    'PATCH /api/company/settings': ({ body }) => ({ body: { hourlyRateCents: (body as { hourlyRateCents: number }).hourlyRateCents } }),
  });
}

describe('hourly rate', () => {
  it('owner sees the rate in dollars', async () => {
    ownerApi();
    renderAt(<CompanyTab />);
    expect(await screen.findByLabelText(rate.label)).toHaveValue('28');
  });

  it('owner saves cents', async () => {
    ownerApi();
    const { user } = renderAt(<CompanyTab />);
    const field = await screen.findByLabelText(rate.label);
    await user.clear(field);
    await user.type(field, '31.50');
    await user.click(save());
    await screen.findByText(rate.saved);
    expect(api.sent('PATCH /api/company/settings')).toEqual([{ hourlyRateCents: 3150 }]);
    expect(screen.getByLabelText(rate.label)).toHaveValue('31.50');
  });

  it('whole dollars', async () => {
    ownerApi();
    const { user } = renderAt(<CompanyTab />);
    const field = await screen.findByLabelText(rate.label);
    await user.clear(field);
    await user.type(field, '30');
    await user.click(save());
    await screen.findByText(rate.saved);
    expect(api.sent('PATCH /api/company/settings')).toEqual([{ hourlyRateCents: 3000 }]);
  });

  it('validation', async () => {
    ownerApi();
    const { user } = renderAt(<CompanyTab />);
    const field = await screen.findByLabelText(rate.label);
    for (const bad of ['1001', 'abc', '-5']) {
      await user.clear(field);
      await user.type(field, bad);
      expect(await screen.findByText(rate.error)).toBeInTheDocument();
      expect(save()).toBeDisabled();
    }
    expect(api.sent('PATCH /api/company/settings')).toHaveLength(0);
    await user.clear(field);
    await user.type(field, '1000');
    expect(screen.queryByText(rate.error)).toBeNull();
    await user.click(save());
    await screen.findByText(rate.saved);
    expect(api.sent('PATCH /api/company/settings')).toEqual([{ hourlyRateCents: 100000 }]);
  });

  it.each(['office', 'rep'] as const)('%s view has no rate field', async (role) => {
    api = stubApi({
      'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role } }),
      'GET /api/company': () => ({ body: COMPANY }),
    });
    renderAt(<CompanyTab />);
    await screen.findByLabelText(settings.company.fields.name);
    expect(screen.queryByLabelText(rate.label)).toBeNull();
  });
});
