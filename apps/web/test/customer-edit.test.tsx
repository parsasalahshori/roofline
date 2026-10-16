import { cleanup, screen, waitFor } from '@testing-library/react';
import type { CustomerView } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { customers } from '../src/copy/customers.ts';
import { EditCustomerSheet } from '../src/features/customers/EditCustomerSheet.tsx';
import { renderAt, stubApi } from './helpers.tsx';
import { chooseFromListbox } from './crm-helpers.ts';

let api: ReturnType<typeof stubApi> | undefined;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
  api = undefined;
});

/** A customer with one primary mobile number, one email and two tags. Pass what differs. */
function makeView(overrides: { can?: Partial<CustomerView['can']>; customer?: Partial<CustomerView['customer']> } = {}): CustomerView {
  return {
    customer: {
      id: 'c1',
      displayName: 'Ann Smith',
      firstName: 'Ann',
      lastName: 'Smith',
      phones: [{ e164: '+12145550100', label: 'Mobile', primary: true }],
      emails: ['ann@example.com'],
      tags: ['roof', 'hail'],
      consent: 'none',
      doNotContact: false,
      source: 'manual',
      archived: false,
      createdAt: '2026-10-01T12:00:00.000Z',
      ...overrides.customer,
    },
    homes: [],
    jobs: [],
    upcoming: [],
    can: { edit: true, changeConsent: true, archive: true, ...overrides.can },
  } as CustomerView;
}

/** Renders the sheet for `view` and returns the stub, the user and the onDone spy. */
function renderSheet(view: CustomerView, routes: Parameters<typeof stubApi>[0] = {}) {
  api = stubApi({
    'PATCH /api/customers/c1': () => ({ body: { ok: true } }),
    ...routes,
  });
  const onDone = vi.fn();
  const rendered = renderAt(<EditCustomerSheet view={view} onDone={onDone} />, '/customers/c1');
  return { ...rendered, onDone, stub: api };
}

const PATCH = 'PATCH /api/customers/c1';

describe('the edit customer sheet', () => {
  it('office changes consent with the confirm', async () => {
    const { user, onDone, stub } = renderSheet(makeView());

    await chooseFromListbox(user, customers.edit.consent, customers.edit.consentOptions.written);
    expect(screen.getByText(customers.edit.consentConfirm)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: customers.edit.save }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const [body] = stub.sent(PATCH) as Record<string, unknown>[];
    expect(body).toMatchObject({ smsConsentStatus: 'written' });
  });

  it('a rep sees no consent select or do-not-contact switch, and sends none of the consent fields', async () => {
    const { user, onDone, stub } = renderSheet(makeView({ can: { changeConsent: false } }));

    expect(screen.queryByLabelText(customers.edit.consent)).toBeNull();
    expect(screen.queryByRole('switch', { name: customers.doNotContact })).toBeNull();

    await user.click(screen.getByRole('button', { name: customers.edit.save }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const [body] = stub.sent(PATCH) as Record<string, unknown>[];
    expect(body).not.toHaveProperty('smsConsentStatus');
    expect(body).not.toHaveProperty('doNotContact');
    expect(body).not.toHaveProperty('consentNote');
  });

  it('a duplicate phone shows the message under the number with a link to search that number', async () => {
    const { user, onDone } = renderSheet(makeView(), {
      [PATCH]: () => ({
        status: 409,
        body: { error: 'Another customer already has this number.', field: 'phones.0.number' },
      }),
    });

    await user.click(screen.getByRole('button', { name: customers.edit.save }));

    expect(await screen.findByText('Another customer already has this number.')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: customers.edit.openThatCustomer });
    expect(link.getAttribute('href')).toMatch(/^\/customers\?q=/);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('tags are split on commas, trimmed and de-duplicated', async () => {
    const { user, onDone, stub } = renderSheet(makeView());

    const tags = screen.getByLabelText(customers.edit.tags);
    await user.clear(tags);
    await user.type(tags, 'roof, vip, roof');
    await user.click(screen.getByRole('button', { name: customers.edit.save }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const [body] = stub.sent(PATCH) as Record<string, unknown>[];
    expect(body).toMatchObject({ tags: ['roof', 'vip'] });
  });

  it('adding a phone and marking it primary sends exactly one primary number', async () => {
    const { user, onDone, stub } = renderSheet(makeView());

    await user.click(screen.getByRole('button', { name: customers.edit.addPhone }));
    const numbers = screen.getAllByLabelText(customers.edit.phoneNumber);
    expect(numbers).toHaveLength(2);
    await user.type(numbers[1] as HTMLElement, '(214) 555-0199');
    await user.click(screen.getAllByRole('checkbox', { name: customers.edit.phonePrimary })[1] as HTMLElement);
    await user.click(screen.getByRole('button', { name: customers.edit.save }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const [body] = stub.sent(PATCH) as { phones: { number: string; primary: boolean }[] }[];
    const phones = body?.phones ?? [];
    expect(phones.filter((phone) => phone.primary)).toHaveLength(1);
    expect(phones[1]).toMatchObject({ number: '(214) 555-0199', primary: true });
    expect(phones[0]).toMatchObject({ primary: false });
  });

  it('an untouched consent select is not sent', async () => {
    const { user, onDone, stub } = renderSheet(makeView({ customer: { consent: 'express' } }));

    await user.click(screen.getByRole('button', { name: customers.edit.save }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const [body] = stub.sent(PATCH) as Record<string, unknown>[];
    expect(body).not.toHaveProperty('smsConsentStatus');
    expect(body).not.toHaveProperty('consentNote');
  });

  it('turning on do not contact sends doNotContact true', async () => {
    const { user, onDone, stub } = renderSheet(makeView());

    await user.click(screen.getByRole('switch', { name: customers.doNotContact }));
    await user.click(screen.getByRole('button', { name: customers.edit.save }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const [body] = stub.sent(PATCH) as Record<string, unknown>[];
    expect(body).toMatchObject({ doNotContact: true });
  });

  it('a written note goes with the written status it records', async () => {
    const { user, onDone, stub } = renderSheet(makeView());

    await chooseFromListbox(user, customers.edit.consent, customers.edit.consentOptions.written);
    await user.type(screen.getByLabelText(customers.edit.consentNote), 'Signed the form on site');
    await user.click(screen.getByRole('button', { name: customers.edit.save }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const [body] = stub.sent(PATCH) as Record<string, unknown>[];
    expect(body).toMatchObject({ smsConsentStatus: 'written', consentNote: 'Signed the form on site' });
  });

  it('a save that fails with a message other than a phone or name error shows it as a toast', async () => {
    const { user, onDone } = renderSheet(makeView(), {
      [PATCH]: () => ({ status: 500, body: { error: 'Something went wrong on our side.' } }),
    });

    await user.click(screen.getByRole('button', { name: customers.edit.save }));

    expect(await screen.findByText('Something went wrong on our side.')).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });
});
