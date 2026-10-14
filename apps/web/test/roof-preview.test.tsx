import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Providers, createQueryClient } from '../src/app/providers.tsx';
import { MakeProposal } from '../src/features/estimator/MakeProposal.tsx';
import { estimator } from '../src/copy/estimator.ts';
import { stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); expect(api?.unexpected ?? []).toEqual([]); });

describe('roof preview before proposal', () => {
  it.each([true, false])('opens measurement for drawMode=%s without customer details or send/build calls', async (drawMode) => {
    api = stubApi({ 'POST /api/measurements': () => ({ body: { id: 'm1', drawMode }, status: 201 }) });
    const router = createMemoryRouter([
      { path: '/', element: <MakeProposal target={{ kind: 'address', address: '1600 Pennsylvania Ave NW, Washington, DC 20500' }} /> },
      { path: '/estimator/measure/:measurementId', element: <div>Roof preview</div> },
    ]);
    render(<Providers client={createQueryClient()}><RouterProvider router={router} /></Providers>);
    expect(screen.getByRole('button', { name: estimator.makeProposal })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole('button', { name: estimator.viewRoofEstimate }));
    await screen.findByText('Roof preview');
    expect(router.state.location.pathname).toBe('/estimator/measure/m1');
    expect(router.state.location.state).toEqual({ needsCustomer: true });
    expect(api.calls.map(c => c.key)).toEqual(['POST /api/measurements']);
  });

  it('keeps the address form and a plain error after refused lookup, with no proposal mutation', async () => {
    api = stubApi({ 'POST /api/measurements': () => ({ status: 400, body: { error: 'We could not find that address.' } }) });
    const router = createMemoryRouter([{ path: '/', element: <MakeProposal target={{ kind: 'address', address: 'Unknown' }} /> }]);
    render(<Providers client={createQueryClient()}><RouterProvider router={router} /></Providers>);
    await userEvent.setup().click(screen.getByRole('button', { name: estimator.viewRoofEstimate }));
    expect(await screen.findByText('We could not find that address.')).toHaveAttribute('role', 'alert');
    await waitFor(() => expect(screen.getByRole('button', { name: estimator.viewRoofEstimate })).not.toBeDisabled());
    expect(router.state.location.pathname).toBe('/');
    expect(api.calls.map(c => c.key)).toEqual(['POST /api/measurements']);
  });
});
