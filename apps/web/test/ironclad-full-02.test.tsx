import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Today } from '../src/features/today/Today.tsx';
import { mapStyle } from '../src/shell/map/mapStyle.ts';
import { PinCard } from '../src/shell/map/PinCard.tsx';
import { today } from '../src/copy/today.ts';
import { ACCOUNT, makeTask, renderAt, stubApi } from './helpers.tsx';
import userEvent from '@testing-library/user-event';

const signedPath = 'GET /api/proposals?status=signed&signedOn=2026-10-12';
let api: ReturnType<typeof stubApi>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T01:30:00Z'));
  api = stubApi({
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/company': () => ({ body: { timezone: 'America/Los_Angeles' } }),
    'GET /api/approvals': () => ({ body: { count: 1, tasks: [makeTask({ id: 'plan/1', title: 'Review the storm plan', status: 'draft' })] } }),
    'GET /api/today': () => ({ body: {
      appointments: [{ id: 'visit/1', kind: 'inspection', startsAt: '2026-10-12T18:00:00Z', allDay: false, customerName: 'Alex Homeowner', addressLine: '12 Oak Street' }],
      followUps: [{ id: 'job/1', customerName: 'Jo Homeowner', nextStep: 'Return the call', frontDesk: 'urgent' }],
    } }),
    [signedPath]: () => ({ body: { total: 1, proposals: [{ id: 'proposal/1', customer: { name: 'Lee Homeowner' }, address: '3 Elm Street', basis: 'estimate', signed: { optionId: 'chosen' }, options: [{ id: 'other', totalCents: 1 }, { id: 'chosen', totalCents: 1200000 }] }] } }),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Ironclad Today widgets', () => {
  it('keeps the real company-zone day and every destination in the home layout, without acknowledging or mutating work', async () => {
    renderAt(<Today layout="home" />);
    expect(await screen.findByRole('heading', { name: 'Good evening, Sam' })).toBeInTheDocument();
    expect(screen.getByText('Monday, October 12')).toBeInTheDocument();
    for (const [name, href] of [
      ['Review the storm plan', '/approvals/plan%2F1'],
      ['Alex Homeowner', '/calendar/appointments/visit%2F1'],
      ['Jo Homeowner', '/jobs/job%2F1'],
      ['Lee Homeowner', '/estimator/proposals/proposal%2F1'],
    ]) {
      expect((await screen.findByText(name!)).closest('a')).toHaveAttribute('href', href);
    }
    expect(screen.getByText(today.fromFrontDeskUrgent)).toBeInTheDocument();
    expect(screen.getByText('Estimate $12,000')).toBeInTheDocument();
    expect(api.calls.every((call) => call.key.startsWith('GET '))).toBe(true);
    expect(api.unexpected).toEqual([]);
  });

  it('lets an owner explore the map and reopen the widgets with the keyboard', async () => {
    const { user } = renderAt(<Today layout="home" />);
    const toggle = screen.getByRole('button', { name: today.exploreMap });
    await screen.findByText('Alex Homeowner');
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('heading', { name: today.appointments })).toBeNull();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Alex Homeowner')).toBeVisible();
  });

  it('retains rep-scoped navigation without introducing monetary summaries', async () => {
    api.routes['GET /api/auth/me'] = () => ({ body: { ...ACCOUNT, role: 'rep' } });
    api.routes[signedPath] = () => ({ body: { total: 0, proposals: [] } });
    renderAt(<Today layout="home" />);
    await screen.findByText(today.signedNone);
    expect(screen.queryByRole('link', { name: today.seeEveryone })).toBeNull();
    expect(screen.queryByText(/\$/)).toBeNull();
    expect(screen.queryByText(/goal|revenue|pipeline/i)).toBeNull();
  });

  it('shows a recoverable signed-proposals error instead of claiming there were no signatures', async () => {
    api.routes[signedPath] = () => ({ status: 503, body: { error: 'Unavailable' } });
    const { user } = renderAt(<Today />);
    const signed = await screen.findByRole('region', { name: today.signedToday });
    const retry = await within(signed).findByRole('button', { name: today.tryAgain });
    expect(within(signed).queryByText(today.signedNone)).toBeNull();
    api.routes[signedPath] = () => ({ body: { total: 0, proposals: [] } });
    await user.click(retry);
    expect(await within(signed).findByText(today.signedNone)).toBeInTheDocument();
  });

  it('keeps pending data distinct from an empty day', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    renderAt(<Today layout="home" />);
    expect(screen.queryByText(today.nothingNeedsYou)).toBeNull();
    expect(screen.queryByText(today.noAppointments)).toBeNull();
    expect(screen.queryByText(today.signedNone)).toBeNull();
  });
});

describe('Ironclad map presentation', () => {
  it('retains a network-free fallback and the geographic raster source while muting its colors', () => {
    const offline = mapStyle({}, 'streets');
    expect(typeof offline).toBe('object');
    if (typeof offline === 'string') return;
    expect(offline.sources).toEqual({});
    expect(offline).not.toHaveProperty('glyphs');
    const osm = mapStyle({ tiles: 'osm' }, 'streets');
    if (typeof osm === 'string') throw new Error('Expected raster style');
    expect(osm.sources.osm).toMatchObject({ tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], attribution: '© OpenStreetMap contributors' });
    expect(osm.layers[0]).toMatchObject({ paint: { 'raster-saturation': -0.7 } });
  });

  it('keeps the selected job and customer actions intact', async () => {
    const user = userEvent.setup();
    for (const kind of ['customer', 'job'] as const) {
      const onOpen = vi.fn();
      const onClose = vi.fn();
      const { unmount } = render(<PinCard pin={{ kind, id: 'real-id', name: 'Selected home', addressLine: '12 Oak St', stage: kind === 'job' ? 'lead' : null, stageLabel: kind === 'job' ? 'Lead' : null, lngLat: [-96, 32] }} onOpen={onOpen} onClose={onClose} />);
      await user.click(screen.getByRole('button', { name: 'Open' }));
      expect(onOpen).toHaveBeenCalledWith({ kind, id: 'real-id' });
      await user.click(screen.getByRole('button', { name: 'Close' }));
      expect(onClose).toHaveBeenCalledOnce();
      unmount();
    }
  });
});
