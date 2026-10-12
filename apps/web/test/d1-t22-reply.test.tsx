import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationDetail } from '@roofline/shared';
import { ConversationWindow } from '../src/features/front-desk/ConversationWindow.tsx';
import { conversationCopy } from '../src/copy/front-desk-conversation.ts';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { ACCOUNT, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi> | undefined;

afterEach(() => {
  cleanup();
  expect(api?.unexpected ?? []).toEqual([]);
  api = undefined;
});

function makeConversation(overrides: Partial<ConversationDetail> = {}): ConversationDetail {
  return {
    id: 'conv1',
    channel: 'sms',
    status: 'active',
    customer: { id: 'c1', name: 'Pat Lee' },
    phoneE164: '+15551230000',
    outcome: null,
    summary: null,
    followUps: [],
    identity: 'matched',
    handledBy: 'assistant',
    teamUntil: null,
    calls: [],
    turns: [],
    links: { jobIds: [], appointmentIds: [], claimIntakeIds: [] },
    canReply: true,
    ...overrides,
  };
}

function renderWindow(conversation: ConversationDetail, replyRoute?: () => { status?: number; body?: unknown }) {
  api = stubApi({
    'GET /api/conversations/conv1': () => ({ body: conversation }),
    'POST /api/conversations/conv1/read': () => ({ body: {} }),
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    ...(replyRoute ? { 'POST /api/conversations/conv1/reply': replyRoute } : {}),
  });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createMemoryRouter(
    [{ path: '/front-desk/:conversationId', element: <ConversationWindow /> }],
    { initialEntries: ['/front-desk/conv1'] },
  );
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { user: userEvent.setup() };
}

describe('ConversationWindow read receipt', () => {
  it('marks the conversation read exactly once when it opens', async () => {
    renderWindow(makeConversation());
    await waitFor(() => expect(api?.count('POST /api/conversations/conv1/read')).toBeGreaterThan(0));
    // Let any extra effect run before counting.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api?.count('POST /api/conversations/conv1/read')).toBe(1);
  });
});

describe('ConversationWindow reply box', () => {
  it('shows the reply box for a text conversation', async () => {
    renderWindow(makeConversation({ canReply: true }));
    expect(await screen.findByLabelText(conversationCopy.replyLabel)).toBeInTheDocument();
  });

  it('does not show the reply box for a voice conversation', async () => {
    renderWindow(makeConversation({ channel: 'voice', canReply: false }));
    // The read receipt fires once the conversation has loaded, so its call means the page is up.
    await waitFor(() => expect(api?.count('POST /api/conversations/conv1/read')).toBe(1));
    expect(screen.queryByLabelText(conversationCopy.replyLabel)).toBeNull();
  });

  it('sends the typed text and clears the box', async () => {
    const { user } = renderWindow(makeConversation(), () => ({ body: { id: 'm1', status: 'sent', scheduledFor: null } }));
    const box = await screen.findByLabelText(conversationCopy.replyLabel);
    await user.type(box, 'On our way');
    await user.click(screen.getByRole('button', { name: conversationCopy.replySend }));

    await waitFor(() => expect(api?.sent('POST /api/conversations/conv1/reply')).toEqual([{ body: 'On our way' }]));
    await waitFor(() => expect(screen.getByLabelText(conversationCopy.replyLabel)).toHaveValue(''));
    expect(screen.queryByText(/scheduled/i)).toBeNull();
  });

  it('says when a reply held by the send gate will go out', async () => {
    const at = '2026-10-15T13:00:00.000Z';
    const { user } = renderWindow(makeConversation(), () => ({ body: { id: 'm1', status: 'scheduled', scheduledFor: at } }));
    const box = await screen.findByLabelText(conversationCopy.replyLabel);
    await user.type(box, 'On our way');
    await user.click(screen.getByRole('button', { name: conversationCopy.replySend }));

    const when = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(at));
    expect(await screen.findByText(conversationCopy.replyScheduled(when))).toBeInTheDocument();
    expect(screen.getByLabelText(conversationCopy.replyLabel)).toHaveValue('');
  });

  it('shows the not-sent sentence for a reply the texting service refused, keeping the text', async () => {
    const sentence = 'We could not send this text.';
    const { user } = renderWindow(makeConversation(), () => ({ status: 422, body: { error: sentence } }));
    const box = await screen.findByLabelText(conversationCopy.replyLabel);
    await user.type(box, 'Hi there');
    await user.click(screen.getByRole('button', { name: conversationCopy.replySend }));

    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expect(screen.getByLabelText(conversationCopy.replyLabel)).toHaveValue('Hi there');
  });

  it('shows the send-gate sentence plainly and keeps the typed text', async () => {
    const gateSentence = 'This person asked us to stop texting.';
    const { user } = renderWindow(makeConversation(), () => ({
      status: 422,
      body: { error: gateSentence },
    }));
    const box = await screen.findByLabelText(conversationCopy.replyLabel);
    await user.type(box, 'Hi there');
    await user.click(screen.getByRole('button', { name: conversationCopy.replySend }));

    expect(await screen.findByText(gateSentence)).toBeInTheDocument();
    expect(screen.getByLabelText(conversationCopy.replyLabel)).toHaveValue('Hi there');
  });

  it('disables Send while the text is empty', async () => {
    const { user } = renderWindow(makeConversation());
    const box = await screen.findByLabelText(conversationCopy.replyLabel);
    const send = screen.getByRole('button', { name: conversationCopy.replySend });
    expect(send).toBeDisabled();

    await user.type(box, '   ');
    expect(send).toBeDisabled();

    await user.type(box, 'Yes');
    expect(send).toBeEnabled();
  });
});
