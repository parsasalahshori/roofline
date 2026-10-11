import { cleanup, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useApprovals, useSwitchCompany } from '../src/api/hooks.ts';
import { keys } from '../src/api/keys.ts';
import type { Account } from '../src/api/types.ts';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { ACCOUNT, ACCOUNT_TWO, makeTask, renderAt, SHELL_ROUTES, stubApi } from './helpers.tsx';

/** The second company as the server answers a switch to it: the same person, with company c2 signed in. */
const RIDGE_ACCOUNT: Account = {
  ...ACCOUNT_TWO,
  company: { id: 'c2', name: 'Ridge Roofing', slug: 'ridge-roofing', status: 'active' },
};

let api: ReturnType<typeof stubApi> | undefined;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
  api = undefined;
});

it("a company switch drops the old company's pins and search", async () => {
  api = stubApi({ 'POST /api/auth/switch-company': () => ({ body: RIDGE_ACCOUNT }) });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  queryClient.setQueryData(keys.pins('1,2,3,4'), { mode: 'points', customers: [], jobs: [] });
  queryClient.setQueryData(keys.search('lop'), { customers: [], jobs: [], addresses: [] });
  queryClient.setQueryData(keys.approvals, { count: 1, tasks: [makeTask({ id: 't1', title: 'Alpha draft' })] });
  queryClient.setQueryData(keys.me, ACCOUNT);

  const wrapper = ({ children }: { children: ReactNode }) => <Providers client={queryClient}>{children}</Providers>;
  const { result } = renderHook(() => useSwitchCompany(), { wrapper });

  result.current.mutate('c2');
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  expect(queryClient.getQueryData(keys.pins('1,2,3,4'))).toBeUndefined();
  expect(queryClient.getQueryData(keys.search('lop'))).toBeUndefined();
  expect(queryClient.getQueryData(keys.me)).toEqual(RIDGE_ACCOUNT);
  expect(api.sent('POST /api/auth/switch-company')).toEqual([{ companyId: 'c2' }]);
});

it('a mounted list reloads for the new company', async () => {
  // Company A's draft until the switch is asked for, then company B's
  let switched = false;
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/approvals': () => ({
      body: { count: 1, tasks: [makeTask({ id: 't1', title: switched ? 'Bravo draft' : 'Alpha draft' })] },
    }),
    'POST /api/auth/switch-company': () => {
      switched = true;
      return { body: RIDGE_ACCOUNT };
    },
  });

  // Every title the list rendered, in order
  const shown: (string | undefined)[] = [];

  function DraftList() {
    const approvals = useApprovals();
    const switchCompany = useSwitchCompany();
    const title = approvals.data?.tasks[0]?.title;
    shown.push(title);
    return (
      <>
        <p>{title ?? 'loading'}</p>
        <button onClick={() => switchCompany.mutate('c2')}>switch</button>
      </>
    );
  }

  const { user } = renderAt(<DraftList />);

  await screen.findByText('Alpha draft');
  await user.click(screen.getByRole('button', { name: 'switch' }));

  await screen.findByText('Bravo draft');
  expect(screen.queryByText('Alpha draft')).toBeNull();

  // Once Bravo has been shown, Alpha never comes back
  const firstBravo = shown.indexOf('Bravo draft');
  expect(firstBravo).toBeGreaterThan(-1);
  expect(shown.slice(firstBravo)).not.toContain('Alpha draft');
  expect(api.sent('POST /api/auth/switch-company')).toEqual([{ companyId: 'c2' }]);
});
