import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useMapPins } from '../src/api/hooks.ts';
import { keys } from '../src/api/keys.ts';
import { createQueryClient } from '../src/app/providers.tsx';
import { useCreateJob } from '../src/features/create/api.ts';
import { ACCOUNT, stubApi } from './helpers.tsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('a real successful creation refreshes mounted map pins and expires related cached views', async () => {
  let created = false;
  const api = stubApi({
    'GET /api/map/pins?bbox=1,2,3,4&layers=customers,jobs': () => ({
      body: { mode: 'points', customers: [], jobs: created ? [{ id: 'new-job' }] : [] },
    }),
    'POST /api/jobs': () => { created = true; return { body: { id: 'new-job' } }; },
  });
  const client = createQueryClient();
  const related = [['jobs-board', 'all'], ['customers', 'list'], keys.search('Pat')];
  for (const key of related) client.setQueryData(key, []);
  client.setQueryData(keys.me, ACCOUNT);
  client.setQueryData(keys.approvals, { count: 0, tasks: [] });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => ({ pins: useMapPins([1, 2, 3, 4]), create: useCreateJob() }), { wrapper });
  await waitFor(() => expect(result.current.pins.isSuccess).toBe(true));
  await act(async () => { await result.current.create.mutateAsync({ customerId: 'c1', propertyId: 'p1' }); });
  await waitFor(() => expect(result.current.pins.data).toMatchObject({ jobs: [{ id: 'new-job' }] }));
  expect(api.count('GET /api/map/pins?bbox=1,2,3,4&layers=customers,jobs')).toBe(2);
  for (const key of related) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  expect(client.getQueryState(keys.me)?.isInvalidated).toBe(false);
  expect(client.getQueryState(keys.approvals)?.isInvalidated).toBe(false);
  expect(api.sent('POST /api/jobs')).toEqual([{ customerId: 'c1', propertyId: 'p1' }]);
  expect(api.unexpected).toEqual([]);
  client.clear();
});
