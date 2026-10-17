import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrand } from '../src/shell/useBrand.ts';
import { ACCOUNT, renderAt, stubApi, type Routes } from './helpers.tsx';

/** What the shell reads from the brand: shown so a test can see it. */
function Probe() {
  const brand = useBrand();
  return <p data-testid="brand">{[brand.name, brand.initials, brand.color ?? 'default', brand.place ?? 'nowhere'].join('|')}</p>;
}

const styleText = () => document.getElementById('roofline-brand')?.textContent ?? null;

function company(extra: Record<string, unknown> = {}) {
  return { id: 'c1', name: 'WinChoice (demo)', timezone: 'America/Chicago', addressCity: 'Little Rock', addressState: 'AR', logoUrl: null, ...extra };
}

function api(routes: Routes) {
  return stubApi({ 'GET /api/auth/me': () => ({ body: ACCOUNT }), ...routes });
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('useBrand', () => {
  it('fills the brand slot from the company colour and names the company', async () => {
    api({ 'GET /api/company': () => ({ body: company({ brandColor: '#ed3a2b' }) }) });
    renderAt(<Probe />);

    expect(await screen.findByText('WinChoice (demo)|WD|#ed3a2b|Little Rock, AR')).toBeInTheDocument();
    // White ink on a fill darkened just enough to pass 4.5:1, and --bad moved off the brand's red
    expect(styleText()).toContain('--brand:#dc3628');
    expect(styleText()).toContain('--brand-ink:#ffffff');
    expect(styleText()).toContain('--bad:#9f251b');
  });

  it('leaves the default blue alone for a company with no colour', async () => {
    api({ 'GET /api/company': () => ({ body: company({ brandColor: null }) }) });
    renderAt(<Probe />);

    expect(await screen.findByText('WinChoice (demo)|WD|default|Little Rock, AR')).toBeInTheDocument();
    expect(styleText()).toBeNull();
  });

  it('ignores a colour it cannot read', async () => {
    api({ 'GET /api/company': () => ({ body: company({ brandColor: 'red; } body { display: none' }) }) });
    renderAt(<Probe />);

    expect(await screen.findByText(/\|default\|/)).toBeInTheDocument();
    expect(styleText()).toBeNull();
  });

  it('paints the cached colour at once, then follows what the company says', async () => {
    window.localStorage.setItem('roofline.brand.c1', '#f2b300');
    api({ 'GET /api/company': () => ({ body: company({ brandColor: null }) }) });
    // The company's own answer arrives late
    const answer = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === '/api/company' ? new Promise<Response>((resolve) => setTimeout(() => resolve(answer(input, init)), 400)) : answer(input, init),
    );
    renderAt(<Probe />);

    // The session answers before the company does; the cache for this company is used in between
    await waitFor(() => expect(styleText()).toContain('--brand:#f2b300'));
    await waitFor(() => expect(styleText()).toBeNull());
    expect(window.localStorage.getItem('roofline.brand.c1')).toBeNull();
  });

  it('remembers the colour for the next load, per company', async () => {
    api({ 'GET /api/company': () => ({ body: company({ brandColor: '#ed3a2b' }) }) });
    renderAt(<Probe />);
    await screen.findByText(/#ed3a2b/);

    await waitFor(() => expect(window.localStorage.getItem('roofline.brand.c1')).toBe('#ed3a2b'));
  });

  it('puts the default back when the shell goes away', async () => {
    api({ 'GET /api/company': () => ({ body: company({ brandColor: '#ed3a2b' }) }) });
    renderAt(<Probe />);
    await screen.findByText(/#ed3a2b/);
    expect(styleText()).not.toBeNull();

    cleanup();
    expect(styleText()).toBeNull();
  });
});
