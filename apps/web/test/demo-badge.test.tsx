import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { demo } from '../src/copy/demo.ts';
import { DemoBadge } from '../src/features/demo/DemoBadge.tsx';
import { renderAt, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

it('shows no badge when GET /api/demo answers { demo: false } (demo mode off)', async () => {
  api = stubApi({ 'GET /api/demo': () => ({ body: { demo: false } }) });
  renderAt(<DemoBadge />);
  await waitFor(() => expect(api.count('GET /api/demo')).toBe(1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByTestId('demo-badge')).toBeNull();
});

it('shows no badge when GET /api/demo answers 404 (an older API)', async () => {
  api = stubApi({ 'GET /api/demo': () => ({ status: 404, body: { error: "We couldn't find that." } }) });
  renderAt(<DemoBadge />);
  await waitFor(() => expect(api.count('GET /api/demo')).toBe(1));
  // Let the 404 settle before checking nothing was drawn.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByTestId('demo-badge')).toBeNull();
});

it('shows no badge when the probe fails', async () => {
  api = stubApi({ 'GET /api/demo': () => ({ status: 500, body: { error: 'Something went wrong on our side. Please try again.' } }) });
  renderAt(<DemoBadge />);
  await waitFor(() => expect(api.count('GET /api/demo')).toBe(1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByTestId('demo-badge')).toBeNull();
});

it('in demo mode shows the badge; it opens the Simulate panel, runs a simulation and shows its message', async () => {
  api = stubApi({
    'GET /api/demo': () => ({ body: { demo: true } }),
    'POST /api/demo/simulate/text': () => ({ body: { ok: true, conversationId: 'cv1', message: 'Dana texted in and Front Desk replied.' } }),
    'POST /api/demo/simulate/sign': () => ({ status: 409, body: { error: 'No sent proposal is waiting for a signature. Send one first.' } }),
  });
  const { user } = renderAt(<DemoBadge />);
  const badge = await screen.findByTestId('demo-badge');
  expect(badge).toHaveTextContent(demo.badge);
  expect(screen.queryByTestId('simulate-panel')).toBeNull();

  await user.click(badge);
  expect(screen.getByTestId('simulate-panel')).toBeInTheDocument();
  expect(screen.getByTestId('simulate-text')).toHaveTextContent(demo.simulateText);
  expect(screen.getByTestId('simulate-call')).toHaveTextContent(demo.simulateCall);
  expect(screen.getByTestId('simulate-storm')).toHaveTextContent(demo.simulateStorm);
  expect(screen.getByTestId('simulate-sign')).toHaveTextContent(demo.simulateSign);

  await user.click(screen.getByTestId('simulate-text'));
  expect(await screen.findByText('Dana texted in and Front Desk replied.')).toBeInTheDocument();
  expect(api.count('POST /api/demo/simulate/text')).toBe(1);

  await user.click(screen.getByTestId('simulate-sign'));
  expect(await screen.findByText('No sent proposal is waiting for a signature. Send one first.')).toBeInTheDocument();
});
