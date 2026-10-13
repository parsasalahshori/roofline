import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PropertyRecordResponse } from '@roofline/shared';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { propertyData } from '../src/copy/propertyData.ts';
import { OwnerRecord } from '../src/features/property-data/OwnerRecord.tsx';
import { stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

const KEY = 'GET /api/properties/p1/record';

/** A fictional county record. */
const RECORD: PropertyRecordResponse = {
  configured: true,
  record: {
    parcelId: '99-00000-001',
    owners: ['SAMPLE JORDAN Q', 'SAMPLE RILEY'],
    ownerOccupied: true,
    mailingAddress: '123 EXAMPLE LANE, FAKETOWN, AR 72999',
    siteAddress: '123 EXAMPLE LN, FAKETOWN, AR 72999',
    county: 'Example',
    yearBuilt: 1987,
    livingSqFt: 1864,
    lastSaleDate: '2019-06-14',
    lastSaleCents: 18_450_000,
    assessedCents: null,
    parcelRing: null,
    source: 'regrid',
    sourceUpdatedAt: '2026-08-20T00:00:00.000Z',
    fetchedAt: '2026-10-13T15:00:00.000Z',
  },
  streetImage: {
    id: '1000000000000002',
    thumbUrl: 'https://scontent.example.fbcdn.net/nearest.jpg',
    capturedAt: '2024-06-01T00:00:00.000Z',
    pageUrl: 'https://www.mapillary.com/app/?pKey=1000000000000002',
  },
};

function renderRecord() {
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  render(
    <Providers client={client}>
      <OwnerRecord propertyId="p1" />
    </Providers>,
  );
  return userEvent.setup();
}

describe('the owner record', () => {
  it('asks nothing until opened, then shows the county facts, the photo and the do-not-contact note', async () => {
    api = stubApi({ [KEY]: () => ({ body: RECORD }) });
    const user = renderRecord();

    expect(api.count(KEY)).toBe(0);
    await user.click(screen.getByRole('button', { name: propertyData.open }));

    expect(await screen.findByText('SAMPLE JORDAN Q; SAMPLE RILEY')).toBeInTheDocument();
    expect(screen.getByText(propertyData.occupiedYes)).toBeInTheDocument();
    expect(screen.getByText('1987')).toBeInTheDocument();
    expect(screen.getByText(propertyData.sqFt(1864))).toBeInTheDocument();
    expect(screen.getByText(propertyData.sale('2019-06-14', 18_450_000))).toBeInTheDocument();
    expect(screen.queryByText(propertyData.assessed)).not.toBeInTheDocument();
    expect(screen.getByText(propertyData.compliance)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: propertyData.photoAlt })).toHaveAttribute('src', RECORD.streetImage?.thumbUrl);
    expect(screen.getByRole('link', { name: propertyData.photoCredit('2024-06-01T00:00:00.000Z') })).toHaveAttribute(
      'href',
      RECORD.streetImage?.pageUrl,
    );
    expect(api.count(KEY)).toBe(1);

    await user.click(screen.getByRole('button', { name: propertyData.hide }));
    await user.click(screen.getByRole('button', { name: propertyData.open }));
    expect(await screen.findByText('SAMPLE JORDAN Q; SAMPLE RILEY')).toBeInTheDocument();
    expect(api.count(KEY)).toBe(1);
  });

  it('says when owner records are not set up', async () => {
    api = stubApi({ [KEY]: () => ({ body: { configured: false, record: null, streetImage: null } }) });
    const user = renderRecord();
    await user.click(screen.getByRole('button', { name: propertyData.open }));
    expect(await screen.findByText(propertyData.notSetUp)).toBeInTheDocument();
  });

  it('says when the county has no record for the home', async () => {
    api = stubApi({ [KEY]: () => ({ body: { configured: true, record: null, streetImage: null } }) });
    const user = renderRecord();
    await user.click(screen.getByRole('button', { name: propertyData.open }));
    expect(await screen.findByText(propertyData.noRecord)).toBeInTheDocument();
  });

  it('shows the server message on an outage, and Try again asks again', async () => {
    const message = "We couldn't reach the property records service. Try again in a minute.";
    api = stubApi({ [KEY]: () => ({ status: 503, body: { error: message } }) });
    const user = renderRecord();
    await user.click(screen.getByRole('button', { name: propertyData.open }));
    expect(await screen.findByText(message)).toBeInTheDocument();

    api.routes[KEY] = () => ({ body: RECORD });
    await user.click(screen.getByRole('button', { name: propertyData.retry }));
    await waitFor(() => expect(api.count(KEY)).toBe(2));
    expect(await screen.findByText('SAMPLE JORDAN Q; SAMPLE RILEY')).toBeInTheDocument();
  });
});
