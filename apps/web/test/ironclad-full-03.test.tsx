import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationDetail, ConversationListItem, FrontDeskWeekStats } from '@roofline/shared';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { frontDeskInbox } from '../src/copy/front-desk-inbox.ts';
import { ACCOUNT, COMPANY, SHELL_ROUTES, stubApi } from './helpers.tsx';

vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return { MapView: () => createElement('div', { 'data-map-mock': true }) };
});

const at = '2026-10-12T16:30:00.000Z';
const stats: FrontDeskWeekStats = {
  weekStart: '2026-10-12', answered: 3, booked: 1, transferred: 0, messages: 2,
  spam: 0, firstReplyMsP50: null, guardBlocks: 0, aiMinutesUsed: 5, aiMinutesIncluded: null,
};
const item = (id: string, name: string): ConversationListItem => ({
  id, name, channel: 'sms', status: 'active', customerId: null, phoneE164: '+15551230001',
  outcome: 'message', summary: `${name} needs an inspection.`, handledBy: 'assistant', unreadCount: 1,
  needsAttention: true, urgent: false, lastMessageAt: at, liveCall: null,
});
const dana = item('dana', 'Dana Ruiz');
const lee = { ...item('lee', 'Lee Park'), summary: 'Call back about the roof.' };
const detail = (row: ConversationListItem): ConversationDetail => ({
  id: row.id, channel: 'sms', status: 'active', customer: { id: `customer-${row.id}`, name: row.name ?? '' },
  phoneE164: row.phoneE164, outcome: 'message', summary: row.summary, followUps: [], identity: 'matched',
  handledBy: 'assistant', teamUntil: null, calls: [], turns: [{
    id: `turn-${row.id}`, callId: null, position: 0, speaker: 'caller', text: `Hello from ${row.name}`,
    truncated: false, at, actions: [],
  }], links: { jobIds: [`job-${row.id}`], appointmentIds: [], claimIntakeIds: [] }, canReply: true,
});
let api: ReturnType<typeof stubApi>;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api.unexpected).toEqual([]);
});
function mount(path = '/front-desk') {
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/company': () => ({ body: { ...COMPANY, timezone: 'America/Los_Angeles' } }),
    'GET /api/front-desk/stats': () => ({ body: stats }),
    'GET /api/conversations?filter=all': () => ({ body: { items: [dana, lee], nextCursor: null } }),
    'GET /api/conversations?filter=messages': () => ({ body: { items: [dana, lee], nextCursor: null } }),
    'GET /api/conversations?filter=spam': () => ({ body: { items: [], nextCursor: null } }),
    'GET /api/conversations/dana': () => ({ body: detail(dana) }),
    'GET /api/conversations/lee': () => ({ body: detail(lee) }),
    'POST /api/conversations/dana/read': () => ({ body: {} }),
    'POST /api/conversations/lee/read': () => ({ body: {} }),
  });
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries: [path] });
  render(<Providers client={client}><RouterProvider router={router} /></Providers>);
  return { user: userEvent.setup(), router };
}

describe('Ironclad Front Desk navigation', () => {
  it('opens the inbox without marking any conversation read, then keeps the chosen filter beside the selected conversation', async () => {
    const { user, router } = mount();
    await screen.findByRole('link', { name: /Dana Ruiz/ });
    expect(screen.getByText(frontDeskInbox.selectReadNote)).toBeInTheDocument();
    expect(api.calls.filter((call) => call.key.endsWith('/read'))).toHaveLength(0);
    const filters = screen.getByRole('group', { name: frontDeskInbox.filtersLabel });
    await user.click(within(filters).getByRole('button', { name: 'Messages' }));
    await user.click(await screen.findByRole('link', { name: /Dana Ruiz/ }));
    expect(await screen.findByRole('heading', { name: 'Dana Ruiz' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/front-desk/dana');
    expect(screen.getByRole('link', { name: /Dana Ruiz/ })).toHaveAttribute('aria-current', 'page');
    expect(within(screen.getByRole('group', { name: frontDeskInbox.filtersLabel })).getByRole('button', { name: 'Messages' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('link', { name: 'Open job' })).toHaveAttribute('href', '/jobs/job-dana');
    expect(screen.getByRole('link', { name: 'Call back' })).toHaveAttribute('href', `tel:${dana.phoneE164}`);
    expect(api.count('POST /api/conversations/dana/read')).toBe(1);
    expect(api.count('POST /api/conversations/lee/read')).toBe(0);
  });

  it('does not carry an unsent reply into another conversation or mark an unselected result read', async () => {
    const { user } = mount();
    await user.click(await screen.findByRole('link', { name: /Dana Ruiz/ }));
    await user.type(await screen.findByLabelText('Your reply'), 'Private draft for Dana');
    await user.click(screen.getByRole('link', { name: /Lee Park/ }));
    expect(await screen.findByRole('heading', { name: 'Lee Park' })).toBeInTheDocument();
    expect(screen.getByLabelText('Your reply')).toHaveValue('');
    expect(api.count('POST /api/conversations/lee/read')).toBe(1);
    const filters = screen.getByRole('group', { name: frontDeskInbox.filtersLabel });
    await user.click(within(filters).getByRole('button', { name: 'Spam' }));
    expect(await screen.findByText(frontDeskInbox.filterEmpty)).toBeInTheDocument();
    expect(screen.getByText('Hello from Lee Park')).toBeInTheDocument();
    expect(api.count('POST /api/conversations/dana/read')).toBe(1);
    expect(api.calls.filter((call) => call.key.endsWith('/reply'))).toHaveLength(0);
  });

  it('supports direct conversation links and an explicit return to the inbox without fetching other conversations first', async () => {
    const { user, router } = mount('/front-desk/dana');
    expect(await screen.findByRole('heading', { name: 'Dana Ruiz' })).toBeInTheDocument();
    expect(api.count('GET /api/conversations?filter=all')).toBe(0);
    await user.click(screen.getByRole('link', { name: 'Back to inbox' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/front-desk'));
    expect(await screen.findByRole('link', { name: /Lee Park/ })).toBeInTheDocument();
    expect(api.count('POST /api/conversations/lee/read')).toBe(0);
  });
});
