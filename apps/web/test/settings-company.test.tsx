import { act, cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keys } from '../src/api/keys.ts';
import type { CompanyBody } from '../src/api/types.ts';
import { errors } from '../src/copy/errors.ts';
import { settings } from '../src/copy/settings.ts';
import { CompanyTab } from '../src/features/settings/CompanyTab.tsx';
import { ACCOUNT, renderAt, stubApi } from './helpers.tsx';

const COMPANY: CompanyBody = {
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
  located: false,
  serviceAreaMiles: null,
};

/** What the form shows for the fixture, by field key. */
const DETAILS = {
  name: 'Summit Roofing',
  phone: '+14025551234',
  email: 'office@summit.example',
  website: 'https://summit.example',
  street: '12 Main St',
  city: 'Omaha',
  state: 'NE',
  zip: '68102',
} as const;

const TEXT_FIELDS = ['name', 'phone', 'email', 'website', 'street', 'city', 'state', 'zip'] as const;

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

describe('company tab', () => {
  it('owner saves only what changed', async () => {
    api = stubApi({
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/company': () => ({ body: COMPANY }),
      'GET /api/company/settings': () => ({ body: { hourlyRateCents: 2800 } }),
      'PATCH /api/company': () => ({ body: { ...COMPANY, phone: '+14025559999' } }),
    });
    const { user } = renderAt(<CompanyTab />);
    const phoneInput = await screen.findByLabelText(settings.company.fields.phone);
    await user.clear(phoneInput);
    await user.type(phoneInput, '4025559999');
    await user.click(screen.getByRole('button', { name: settings.company.save }));

    await screen.findByText(settings.company.saved);
    expect(api.sent('PATCH /api/company')).toEqual([{ phone: '4025559999' }]);
    expect(screen.getByLabelText(settings.company.fields.phone)).toHaveValue('+14025559999');
    expect(screen.getByRole('button', { name: settings.company.save })).toBeDisabled();
  });

  it('save is off until something changes', async () => {
    api = stubApi({
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/company': () => ({ body: COMPANY }),
      'GET /api/company/settings': () => ({ body: { hourlyRateCents: 2800 } }),
    });
    const { user } = renderAt(<CompanyTab />);
    const city = await screen.findByLabelText(settings.company.fields.city);
    expect(screen.getByRole('button', { name: settings.company.save })).toBeDisabled();

    await user.type(city, ' West');
    expect(screen.getByRole('button', { name: settings.company.save })).toBeEnabled();
  });

  it('a failed background refresh keeps what was typed', async () => {
    api = stubApi({
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/company': () => ({ body: COMPANY }),
      'GET /api/company/settings': () => ({ body: { hourlyRateCents: 2800 } }),
    });
    const { user, queryClient } = renderAt(<CompanyTab />);
    const city = await screen.findByLabelText(settings.company.fields.city);
    await user.type(city, ' West');

    api.routes['GET /api/company'] = () => ({ status: 500, body: { error: 'Something went wrong.' } });
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: keys.company }).catch(() => {});
      // let the query client's batched notify (a 0 ms timer) reach React inside act
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(api.count('GET /api/company')).toBe(2);
    expect(queryClient.getQueryState(keys.company)?.status).toBe('error');
    expect(screen.getByLabelText(settings.company.fields.city)).toHaveValue('Omaha West');
    expect(screen.queryByRole('button', { name: errors.tryAgain })).toBeNull();
  });

  it('an emptied field is sent as an empty string', async () => {
    api = stubApi({
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/company': () => ({ body: COMPANY }),
      'GET /api/company/settings': () => ({ body: { hourlyRateCents: 2800 } }),
      'PATCH /api/company': () => ({ body: { ...COMPANY, website: null } }),
    });
    const { user } = renderAt(<CompanyTab />);
    const website = await screen.findByLabelText(settings.company.fields.website);
    await user.clear(website);
    await user.click(screen.getByRole('button', { name: settings.company.save }));

    await screen.findByText(settings.company.saved);
    expect(api.sent('PATCH /api/company')).toEqual([{ website: '' }]);
  });

  it('a changed time zone is sent', async () => {
    api = stubApi({
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/company': () => ({ body: COMPANY }),
      'GET /api/company/settings': () => ({ body: { hourlyRateCents: 2800 } }),
      'PATCH /api/company': () => ({ body: { ...COMPANY, timezone: 'America/Denver' } }),
    });
    const { user } = renderAt(<CompanyTab />);
    await screen.findByLabelText(settings.company.fields.name);
    await user.selectOptions(screen.getByLabelText(settings.company.fields.timezone), 'America/Denver');
    await user.click(screen.getByRole('button', { name: settings.company.save }));

    await screen.findByText(settings.company.saved);
    expect(api.sent('PATCH /api/company')).toEqual([{ timezone: 'America/Denver' }]);
  });

  it('shows the field error from the server', async () => {
    const message = 'Please enter a web address, like https://example.com.';
    api = stubApi({
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/company': () => ({ body: COMPANY }),
      'GET /api/company/settings': () => ({ body: { hourlyRateCents: 2800 } }),
      'PATCH /api/company': () => ({ status: 400, body: { error: message, field: 'website' } }),
    });
    const { user } = renderAt(<CompanyTab />);
    const website = await screen.findByLabelText(settings.company.fields.website);
    await user.clear(website);
    await user.type(website, 'summit');
    await user.click(screen.getByRole('button', { name: settings.company.save }));

    // Exactly one match: the message sits under the field and is not also a toast
    await screen.findByText(message);
    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(screen.getByLabelText(settings.company.fields.website)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: settings.company.save })).toBeInTheDocument();
  });

  it('shows an error without a field as a toast', async () => {
    const message = 'Only the owner can do that.';
    api = stubApi({
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/company': () => ({ body: COMPANY }),
      'GET /api/company/settings': () => ({ body: { hourlyRateCents: 2800 } }),
      'PATCH /api/company': () => ({ status: 403, body: { error: message } }),
    });
    const { user } = renderAt(<CompanyTab />);
    const city = await screen.findByLabelText(settings.company.fields.city);
    await user.type(city, ' West');
    await user.click(screen.getByRole('button', { name: settings.company.save }));

    await screen.findByText(message);
    for (const field of screen.getAllByRole('textbox')) {
      expect(field).not.toHaveAttribute('aria-invalid');
    }
  });

  it('office sees read-only company details', async () => {
    api = stubApi({
      'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role: 'office' } }),
      'GET /api/company': () => ({ body: COMPANY }),
    });
    renderAt(<CompanyTab />);
    await screen.findByLabelText(settings.company.fields.name);

    for (const key of TEXT_FIELDS) {
      const input = screen.getByLabelText(settings.company.fields[key]);
      expect(input).toHaveAttribute('readonly');
      expect(input).toHaveValue(DETAILS[key]);
    }
    const timezone = screen.getByLabelText(settings.company.fields.timezone);
    expect(timezone).toBeDisabled();
    expect(timezone).toHaveValue('America/Chicago');
    expect(screen.getByText(settings.company.ownerOnly)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: settings.company.save })).toBeNull();
  });

  it('lists the US time zones and keeps one that is not in the list', async () => {
    api = stubApi({
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/company': () => ({ body: { ...COMPANY, timezone: 'Europe/Berlin' } }),
      'GET /api/company/settings': () => ({ body: { hourlyRateCents: 2800 } }),
    });
    renderAt(<CompanyTab />);
    const timezone = await screen.findByLabelText(settings.company.fields.timezone);

    const values = within(timezone)
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value);
    expect(values).toEqual(['Europe/Berlin', ...settings.company.timeZones.map((zone) => zone.value)]);
    expect(timezone).toHaveValue('Europe/Berlin');
  });

  it('owner sees the details of the company', async () => {
    api = stubApi({
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/company': () => ({ body: COMPANY }),
      'GET /api/company/settings': () => ({ body: { hourlyRateCents: 2800 } }),
    });
    renderAt(<CompanyTab />);
    await screen.findByLabelText(settings.company.fields.name);

    for (const key of TEXT_FIELDS) {
      const input = screen.getByLabelText(settings.company.fields[key]);
      expect(input).toHaveValue(DETAILS[key]);
      expect(input).not.toHaveAttribute('readonly');
    }
    expect(screen.getByLabelText(settings.company.fields.timezone)).toHaveValue('America/Chicago');
    expect(screen.getByLabelText(settings.company.fields.name)).toHaveValue('Summit Roofing');
    expect(screen.getByLabelText(settings.company.fields.phone)).toHaveValue('+14025551234');
    expect(screen.getByLabelText(settings.company.fields.zip)).toHaveValue('68102');
  });
});
