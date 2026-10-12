import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keys } from '../src/api/keys.ts';
import { shell } from '../src/copy/shell.ts';
import { AgentsWorking } from '../src/shell/topbar/AgentsWorking.tsx';
import { ShellTopBar } from '../src/shell/topbar/ShellTopBar.tsx';
import { WeatherChip } from '../src/shell/topbar/WeatherChip.tsx';
import { ACCOUNT, makeTask, renderAt, SHELL_ROUTES, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

const SUNNY = {
  tempF: 71.6,
  summary: 'Sunny and warm',
  icon: 'sun',
  isDaytime: true,
  updatedAt: '2026-10-11T12:00:00.000Z',
};

describe('agents working', () => {
  it.each([0, 1, 3])('says how many agents are working (%i)', async (working) => {
    api = stubApi({ ...SHELL_ROUTES, 'GET /api/tasks/summary': () => ({ body: { working } }) });
    renderAt(<AgentsWorking />);
    const text = await screen.findByText(shell.agentsWorking(working));
    expect(text).toHaveAttribute('data-state', working > 0 ? 'working' : 'quiet');
  });

  it('is a link to the activity feed', async () => {
    api = stubApi({ ...SHELL_ROUTES, 'GET /api/tasks/summary': () => ({ body: { working: 2 } }) });
    renderAt(<AgentsWorking />);
    const text = await screen.findByText(shell.agentsWorking(2));
    expect(text).toHaveAttribute('data-state', 'working');
    expect(screen.getByRole('link', { name: shell.agentsWorking(2) })).toHaveAttribute('href', '/agents/feed');
  });

  it('shows nothing when the count cannot be loaded', async () => {
    api = stubApi({
      ...SHELL_ROUTES,
      'GET /api/tasks/summary': () => ({ status: 500, body: { error: 'Tasks are down.' } }),
    });
    const { queryClient } = renderAt(<AgentsWorking />);
    await waitFor(() => expect(queryClient.getQueryState(keys.summary)?.status).toBe('error'));
    expect(screen.queryByText(shell.agentsWorking(0))).toBeNull();
    expect(document.querySelector('[data-state]')).toBeNull();
  });
});

describe('weather', () => {
  it('shows the temperature and the summary', async () => {
    api = stubApi({ ...SHELL_ROUTES, 'GET /api/weather': () => ({ body: { weather: SUNNY } }) });
    renderAt(<WeatherChip />);
    expect(await screen.findByText(shell.degrees(SUNNY.tempF))).toBeInTheDocument();
    expect(screen.getByText(SUNNY.summary)).toBeInTheDocument();
    expect(document.querySelector('[data-weather]')).toHaveAttribute('data-weather', 'sun');
  });

  it('hides the weather when there is none or it fails', async () => {
    api = stubApi({ ...SHELL_ROUTES, 'GET /api/weather': () => ({ body: { weather: null } }) });
    const first = renderAt(<WeatherChip />);
    await waitFor(() => expect(first.queryClient.getQueryState(keys.weather)?.status).toBe('success'));
    expect(document.querySelector('[data-weather]')).toBeNull();

    cleanup();
    api.routes['GET /api/weather'] = () => ({ status: 500, body: { error: 'Weather is down.' } });
    const second = renderAt(<WeatherChip />);
    await waitFor(() => expect(second.queryClient.getQueryState(keys.weather)?.status).toBe('error'));
    expect(document.querySelector('[data-weather]')).toBeNull();
    // The toast region for errors is always on the page; a failed weather read must not fill it
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });
});

describe('top bar', () => {
  it('shows the company name and the pieces', async () => {
    api = stubApi({
      ...SHELL_ROUTES,
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/approvals': () => ({ body: { count: 1, tasks: [makeTask({ id: 't1' })] } }),
      'GET /api/tasks/summary': () => ({ body: { working: 2 } }),
    });
    renderAt(<ShellTopBar />);
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(await screen.findByText(ACCOUNT.company.name)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: shell.needYourOk(1) })).toHaveAttribute('href', '/approvals/t1');
    expect(await screen.findByText(shell.agentsWorking(2))).toBeInTheDocument();
  });
});
