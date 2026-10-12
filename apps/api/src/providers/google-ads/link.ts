import { AdPlatformError } from '../ads-google.ts';
import type { GoogleAdsHttp } from './http.ts';

export type GoogleAdsLink = {
  invite(customerId: string): Promise<void>;
  linkStatus(customerId: string): Promise<'pending' | 'active' | 'refused' | 'none'>;
  accountInfo(customerId: string): Promise<{ name: string; currency: string }>;
};

type LinkState = 'pending' | 'active' | 'refused' | 'none';

/** When Google returns several links for one client, the most useful state wins: active, then pending, then refused. */
const RANK: Record<LinkState, number> = { active: 3, pending: 2, refused: 1, none: 0 };

/** Google Ads ids are dashed in the UI and bare in the API. */
function digits(id: string): string {
  return id.replace(/-/g, '');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function mapStatus(status: string): LinkState {
  switch (status) {
    case 'PENDING':
      return 'pending';
    case 'ACTIVE':
      return 'active';
    case 'REFUSED':
    case 'CANCELED':
      return 'refused';
    default:
      return 'none';
  }
}

export function createLink(http: GoogleAdsHttp, managerId: string): GoogleAdsLink {
  const manager = digits(managerId);

  async function linkStatus(customerId: string): Promise<LinkState> {
    const clientName = `customers/${digits(customerId)}`;
    const rows = await http.search(
      manager,
      `SELECT customer_client_link.client_customer, customer_client_link.status FROM customer_client_link WHERE customer_client_link.client_customer = '${clientName}'`,
    );

    let best: LinkState = 'none';
    for (const row of rows) {
      const link = asRecord(asRecord(row)?.customerClientLink);
      if (text(link?.clientCustomer) !== clientName) continue;
      const state = mapStatus(text(link?.status));
      if (RANK[state] > RANK[best]) best = state;
    }
    return best;
  }

  return {
    linkStatus: async (customerId: string) => linkStatus(customerId),

    async invite(customerId: string): Promise<void> {
      const client = digits(customerId);
      const state = await linkStatus(client);
      if (state === 'pending' || state === 'active') return;

      await http.request('POST', `customers/${manager}/customerClientLinks:mutate`, {
        operation: { create: { clientCustomer: `customers/${client}`, status: 'PENDING' } },
      });
    },

    async accountInfo(customerId: string): Promise<{ name: string; currency: string }> {
      const rows = await http.search(
        digits(customerId),
        'SELECT customer.descriptive_name, customer.currency_code FROM customer LIMIT 1',
      );
      const first = rows[0];
      if (first === undefined) throw new AdPlatformError('access');

      const customer = asRecord(asRecord(first)?.customer);
      return { name: text(customer?.descriptiveName), currency: text(customer?.currencyCode) };
    },
  };
}
