import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRecents, type Recent, recordRecent, useRecordRecent } from '../src/shell/recents.ts';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { ACCOUNT, stubApi } from './helpers.tsx';

const KEY = 'roofline.recents.c1';
const job = (id: string, label = `Job ${id}`): Recent => ({ kind: 'job', id, label });
const customer = (id: string, label = `Customer ${id}`): Recent => ({ kind: 'customer', id, label });

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('readRecents and recordRecent', () => {
  it('returns nothing before anything is recorded', () => {
    expect(readRecents('c1')).toEqual([]);
  });

  it('lists the newest first', () => {
    recordRecent('c1', job('j1'));
    recordRecent('c1', customer('c1'));
    recordRecent('c1', job('j2'));

    expect(readRecents('c1')).toEqual([job('j2'), customer('c1'), job('j1')]);
  });

  it('moves a repeated entry to the front instead of listing it twice', () => {
    recordRecent('c1', job('j1'));
    recordRecent('c1', job('j2'));
    recordRecent('c1', job('j1', 'Renamed job'));

    expect(readRecents('c1')).toEqual([job('j1', 'Renamed job'), job('j2')]);
  });

  it('treats a job and a customer with the same id as different entries', () => {
    recordRecent('c1', job('42'));
    recordRecent('c1', customer('42'));

    expect(readRecents('c1')).toEqual([customer('42'), job('42')]);
  });

  it('keeps at most eight entries', () => {
    for (let i = 1; i <= 10; i += 1) recordRecent('c1', job(`j${i}`));

    const recents = readRecents('c1');
    expect(recents).toHaveLength(8);
    expect(recents[0]).toEqual(job('j10'));
    expect(recents[7]).toEqual(job('j3'));
  });

  it('keeps each company in its own key', () => {
    recordRecent('c1', job('j1'));
    recordRecent('c2', customer('c9'));

    expect(readRecents('c1')).toEqual([job('j1')]);
    expect(readRecents('c2')).toEqual([customer('c9')]);
    expect(window.localStorage.getItem('roofline.recents.c1')).not.toBeNull();
    expect(window.localStorage.getItem('roofline.recents.c2')).not.toBeNull();
  });

  it('returns nothing for corrupt JSON', () => {
    window.localStorage.setItem(KEY, '{not json');
    expect(readRecents('c1')).toEqual([]);
  });

  it('returns nothing when the stored value is not a list', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ kind: 'job', id: 'j1', label: 'x' }));
    expect(readRecents('c1')).toEqual([]);
  });

  it('drops entries of the wrong shape and keeps the valid ones', () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify([job('j1'), { kind: 'quote', id: 'q1', label: 'Quote' }, { kind: 'customer', id: 7, label: 'Bad id' }, null, 'text', customer('c1')]),
    );
    expect(readRecents('c1')).toEqual([job('j1'), customer('c1')]);
  });

  it('does not throw when localStorage reads throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readRecents('c1')).toEqual([]);
  });

  it('does not throw when localStorage writes throw', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => recordRecent('c1', job('j1'))).not.toThrow();
  });
});

describe('useRecordRecent', () => {
  function stubAccount(status = 200) {
    return stubApi({
      'GET /api/auth/me': () => (status === 200 ? { body: ACCOUNT } : { status, body: { error: 'Sign in first.' } }),
    });
  }

  function Probe({ recent }: { recent: Recent }) {
    useRecordRecent(recent);
    return null;
  }

  /** Renders the probe under Providers; rerender gives it another entry on the same mount. */
  function mountProbe(recent: Recent) {
    const client = createQueryClient();
    client.setDefaultOptions({ queries: { retry: false } });
    const tree = (entry: Recent) => (
      <Providers client={client}>
        <Probe recent={entry} />
      </Providers>
    );
    const { rerender, unmount } = render(tree(recent));
    return { rerender: (next: Recent) => rerender(tree(next)), unmount };
  }

  it('records the entry once the company is known', async () => {
    stubAccount();
    mountProbe(job('j1'));

    await waitFor(() => expect(readRecents('c1')).toEqual([job('j1')]));
  });

  it('records once per mount, not again on a re-render', async () => {
    const api = stubAccount();
    const { rerender } = mountProbe(job('j1'));
    await waitFor(() => expect(readRecents('c1')).toEqual([job('j1')]));

    rerender(job('j2'));
    await waitFor(() => expect(api.count('GET /api/auth/me')).toBeGreaterThan(0));
    expect(readRecents('c1')).toEqual([job('j1')]);
  });

  it('records again on a new mount', async () => {
    stubAccount();
    const first = mountProbe(job('j1'));
    await waitFor(() => expect(readRecents('c1')).toEqual([job('j1')]));
    first.unmount();

    mountProbe(job('j2'));
    await waitFor(() => expect(readRecents('c1')).toEqual([job('j2'), job('j1')]));
  });

  it('does not record while the company is unknown', async () => {
    const api = stubAccount(401);
    mountProbe(job('j1'));
    await waitFor(() => expect(api.count('GET /api/auth/me')).toBeGreaterThan(0));

    expect(readRecents('c1')).toEqual([]);
  });
});
