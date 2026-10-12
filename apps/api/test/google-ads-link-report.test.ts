import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import { AdPlatformError } from '../src/providers/ads-google.ts';
import type { GoogleAdsHttp } from '../src/providers/google-ads/http.ts';
import { createLink } from '../src/providers/google-ads/link.ts';
import { createReport } from '../src/providers/google-ads/report.ts';

/*
 * Manager links and campaign reporting, against canned responses. Nothing here reaches Google: every
 * test passes a fake GoogleAdsHttp that answers from the recorded fixtures, so a missing route fails loudly.
 */

function fixture(name: string): Record<string, unknown> {
  const text = readFileSync(new URL(`./fixtures/google-ads/${name}.json`, import.meta.url), 'utf8');
  return JSON.parse(text) as Record<string, unknown>;
}

function rowsOf(name: string): Record<string, unknown>[] {
  return (fixture(name).results ?? []) as Record<string, unknown>[];
}

function fakeHttp(searchRows: Record<string, unknown>[] = [], requestBody: Record<string, unknown> = {}) {
  const search = vi.fn<GoogleAdsHttp['search']>(async () => searchRows);
  const mutate = vi.fn<GoogleAdsHttp['mutate']>(async () => []);
  const request = vi.fn<GoogleAdsHttp['request']>(async () => requestBody);
  return { http: { search, mutate, request } satisfies GoogleAdsHttp, search, mutate, request };
}

describe('linkStatus', () => {
  test('linkStatus maps pending/active/refused/none', async () => {
    const pending = createLink(fakeHttp(rowsOf('link-search-pending')).http, '1112223333');
    const active = createLink(fakeHttp(rowsOf('link-search-active')).http, '1112223333');
    const refused = createLink(fakeHttp(rowsOf('link-search-refused')).http, '1112223333');
    const none = createLink(fakeHttp(rowsOf('link-search-none')).http, '1112223333');

    await expect(pending.linkStatus('9876543210')).resolves.toBe('pending');
    await expect(active.linkStatus('9876543210')).resolves.toBe('active');
    await expect(refused.linkStatus('9876543210')).resolves.toBe('refused');
    await expect(none.linkStatus('9876543210')).resolves.toBe('none');
  });

  test('linkStatus searches under the manager with dashes stripped', async () => {
    const { http, search } = fakeHttp(rowsOf('link-search-pending'));
    await createLink(http, '111-222-3333').linkStatus('987-654-3210');
    expect(search).toHaveBeenCalledTimes(1);
    const [customerId, query] = search.mock.calls[0] ?? [];
    expect(customerId).toBe('1112223333');
    expect(query).toContain("customer_client_link.client_customer = 'customers/9876543210'");
  });
});

describe('invite', () => {
  test('invite creates a PENDING link under the manager with dashes stripped', async () => {
    const { http, request } = fakeHttp(rowsOf('link-search-none'), fixture('link-create'));
    await createLink(http, '111-222-3333').invite('987-654-3210');

    expect(request).toHaveBeenCalledTimes(1);
    const [method, path, body] = request.mock.calls[0] ?? [];
    expect(method).toBe('POST');
    expect(path).toBe('customers/1112223333/customerClientLinks:mutate');
    expect(body).toEqual({
      operation: { create: { clientCustomer: 'customers/9876543210', status: 'PENDING' } },
    });
  });

  test('invite does nothing when already pending', async () => {
    const { http, request } = fakeHttp(rowsOf('link-search-pending'));
    await expect(createLink(http, '1112223333').invite('9876543210')).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  test('invite does nothing when already active', async () => {
    const { http, request } = fakeHttp(rowsOf('link-search-active'));
    await createLink(http, '1112223333').invite('9876543210');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('accountInfo', () => {
  test('accountInfo returns name and currency', async () => {
    const { http, search } = fakeHttp(rowsOf('customer-info'));
    const info = await createLink(http, '1112223333').accountInfo('987-654-3210');
    expect(info).toEqual({ name: 'Acme Roofing', currency: 'USD' });
    expect(search.mock.calls[0]?.[0]).toBe('9876543210');
  });

  test('accountInfo with no row throws AdPlatformError access', async () => {
    const { http } = fakeHttp(rowsOf('report-empty'));
    const error = await createLink(http, '1112223333')
      .accountInfo('9876543210')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdPlatformError);
    expect((error as AdPlatformError).kind).toBe('access');
  });
});

describe('stats', () => {
  test('stats converts micros to cents', async () => {
    const { http } = fakeHttp(rowsOf('report-campaign'));
    const stats = await createReport(http).stats('9876543210', '555');
    expect(stats).toEqual({ spendCents: 1235, impressions: 900, clicks: 41, status: 'paused' });
  });

  test('stats with no rows is removed with zeros', async () => {
    const { http } = fakeHttp(rowsOf('report-empty'));
    const stats = await createReport(http).stats('9876543210', '555');
    expect(stats).toEqual({ spendCents: 0, impressions: 0, clicks: 0, status: 'removed' });
  });

  test('stats rejects a non-numeric campaign id without calling http', async () => {
    const { http, search } = fakeHttp(rowsOf('report-campaign'));
    const error = await createReport(http)
      .stats('9876543210', '555; DROP TABLE')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdPlatformError);
    expect((error as AdPlatformError).kind).toBe('other');
    expect(search).not.toHaveBeenCalled();
  });

  test('ENABLED maps to active', async () => {
    const row = {
      campaign: { resourceName: 'customers/9876543210/campaigns/555', id: '555', status: 'ENABLED' },
      metrics: { costMicros: '20000', impressions: '3', clicks: '1' },
    };
    const { http } = fakeHttp([row]);
    const stats = await createReport(http).stats('9876543210', '555');
    expect(stats.status).toBe('active');
    expect(stats.spendCents).toBe(2);
  });
});
