import { describe, expect, it } from 'vitest';
import { AdPlatformError } from '../src/providers/ads-google.ts';
import type { MetaHttp } from '../src/providers/meta/http.ts';
import { verifyAccess } from '../src/providers/meta/link.ts';
import { metaStats } from '../src/providers/meta/report.ts';
import { fixture } from './meta-helpers.ts';

type Call = { method: 'GET' | 'POST'; path: string; arg: unknown };

/** Hand-built fake MetaHttp: returns answers in order keyed by method and path; throws AdPlatformError when told to. */
function fakeHttp(answers: Record<string, unknown | AdPlatformError>) {
  const calls: Call[] = [];
  const answer = (key: string): unknown => {
    if (!(key in answers)) throw new Error(`unexpected call ${key}`);
    const v = answers[key];
    if (v instanceof AdPlatformError) throw v;
    return v;
  };
  const http: MetaHttp = {
    async get(path, query) {
      calls.push({ method: 'GET', path, arg: query });
      return answer(`GET ${path}`);
    },
    async post(path, body) {
      calls.push({ method: 'POST', path, arg: body });
      return answer(`POST ${path}`);
    },
  };
  return { http, calls };
}

describe('verifyAccess', () => {
  it('checks the account, assigns the system user and returns the name and currency', async () => {
    const { http, calls } = fakeHttp({
      'GET act_111': JSON.parse(fixture('account.json')),
      'POST act_111/assigned_users': JSON.parse(fixture('assigned-users.json')),
    });
    const result = await verifyAccess(http, 'act_111', 'sys-1');
    expect(result).toEqual({ ok: true, name: 'Acme Roofing', currency: 'USD' });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ method: 'GET', path: 'act_111', arg: { fields: 'name,currency,account_status' } });
    expect(calls[1]).toEqual({
      method: 'POST',
      path: 'act_111/assigned_users',
      arg: { user: 'sys-1', tasks: ['ADVERTISE', 'ANALYZE'] },
    });
  });

  it('normalises a bare numeric id to act_<id>', async () => {
    const { http, calls } = fakeHttp({
      'GET act_111': JSON.parse(fixture('account.json')),
      'POST act_111/assigned_users': { success: true },
    });
    const result = await verifyAccess(http, '111', 'sys-1');
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.path)).toEqual(['act_111', 'act_111/assigned_users']);
  });

  it('returns not_shared when reading the account fails', async () => {
    const { http, calls } = fakeHttp({ 'GET act_111': new AdPlatformError('access', 403, { code: 200 }) });
    expect(await verifyAccess(http, 'act_111', 'sys-1')).toEqual({ ok: false, reason: 'not_shared' });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('returns disabled for a disabled account and makes no assignment call', async () => {
    const { http, calls } = fakeHttp({ 'GET act_111': JSON.parse(fixture('account-disabled.json')) });
    expect(await verifyAccess(http, 'act_111', 'sys-1')).toEqual({ ok: false, reason: 'disabled' });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('returns not_assigned when the assignment call fails', async () => {
    const { http } = fakeHttp({
      'GET act_111': JSON.parse(fixture('account.json')),
      'POST act_111/assigned_users': new AdPlatformError('access', 400, { code: 100, subcode: 33 }),
    });
    expect(await verifyAccess(http, 'act_111', 'sys-1')).toEqual({ ok: false, reason: 'not_assigned' });
  });

  it('returns not_assigned when the assignment response lacks success true', async () => {
    const { http } = fakeHttp({
      'GET act_111': JSON.parse(fixture('account.json')),
      'POST act_111/assigned_users': {},
    });
    expect(await verifyAccess(http, 'act_111', 'sys-1')).toEqual({ ok: false, reason: 'not_assigned' });
  });

  it('does not leak provider text in the result', async () => {
    const { http } = fakeHttp({
      'GET act_111': JSON.parse(fixture('account.json')),
      'POST act_111/assigned_users': new AdPlatformError('access', 400, { code: 100, subcode: 33 }),
    });
    expect(JSON.stringify(await verifyAccess(http, 'act_111', 'sys-1'))).not.toMatch(/Graph|message|error/i);
  });

  it('maps code 100 subcode 33, code 10 and codes 200-299 on the account GET to not_shared', async () => {
    for (const graph of [{ code: 100, subcode: 33 }, { code: 10 }, { code: 200 }, { code: 299 }]) {
      const { http, calls } = fakeHttp({ 'GET act_111': new AdPlatformError('access', 403, graph) });
      expect(await verifyAccess(http, 'act_111', 'sys-1')).toEqual({ ok: false, reason: 'not_shared' });
      expect(calls.some((c) => c.method === 'POST')).toBe(false);
    }
  });

  it('maps the same permission errors on assigned_users to not_assigned', async () => {
    for (const graph of [{ code: 10 }, { code: 100, subcode: 33 }, { code: 299 }]) {
      const { http } = fakeHttp({
        'GET act_111': JSON.parse(fixture('account.json')),
        'POST act_111/assigned_users': new AdPlatformError('access', 400, graph),
      });
      expect(await verifyAccess(http, 'act_111', 'sys-1')).toEqual({ ok: false, reason: 'not_assigned' });
    }
  });

  it('throws a rate limit (code 4 or 17) instead of returning not_shared', async () => {
    for (const graph of [{ code: 17 }, { code: 4 }]) {
      const thrown = new AdPlatformError('other', 400, graph);
      const { http } = fakeHttp({ 'GET act_111': thrown });
      await expect(verifyAccess(http, 'act_111', 'sys-1')).rejects.toBe(thrown);
    }
  });

  it('throws an expired token (code 190) as access, on the GET and on assigned_users', async () => {
    const onGet = new AdPlatformError('access', 400, { code: 190, subcode: 463 });
    const getCase = fakeHttp({ 'GET act_111': onGet });
    await expect(verifyAccess(getCase.http, 'act_111', 'sys-1')).rejects.toMatchObject({ kind: 'access' });

    const onPost = new AdPlatformError('access', 400, { code: 190, subcode: 463 });
    const postCase = fakeHttp({
      'GET act_111': JSON.parse(fixture('account.json')),
      'POST act_111/assigned_users': onPost,
    });
    await expect(verifyAccess(postCase.http, 'act_111', 'sys-1')).rejects.toBe(onPost);
  });

  it('throws a network failure with no graph info', async () => {
    const thrown = new AdPlatformError('other');
    const { http } = fakeHttp({ 'GET act_111': thrown });
    await expect(verifyAccess(http, 'act_111', 'sys-1')).rejects.toBe(thrown);
  });

  it('does not call assigned_users when the GET is thrown', async () => {
    const { http, calls } = fakeHttp({ 'GET act_111': new AdPlatformError('other', 500, { code: 17 }) });
    await expect(verifyAccess(http, 'act_111', 'sys-1')).rejects.toBeInstanceOf(AdPlatformError);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('throws code 100 with another subcode instead of mapping it', async () => {
    const thrown = new AdPlatformError('other', 400, { code: 100, subcode: 1487851 });
    const { http } = fakeHttp({ 'GET act_111': thrown });
    await expect(verifyAccess(http, 'act_111', 'sys-1')).rejects.toBe(thrown);
  });
});

describe('metaStats', () => {
  it('converts spend to cents and reads impressions and clicks, status active', async () => {
    const { http, calls } = fakeHttp({
      'GET c1/insights': JSON.parse(fixture('insights.json')),
      'GET c1': JSON.parse(fixture('campaign-status-active.json')),
    });
    const stats = await metaStats(http, 'act_111', 'c1');
    expect(stats).toEqual({ spendCents: 1234, impressions: 1500, clicks: 27, status: 'active' });
    expect(calls[0]).toEqual({
      method: 'GET',
      path: 'c1/insights',
      arg: { fields: 'spend,impressions,clicks', date_preset: 'maximum' },
    });
    expect(calls[1]).toEqual({ method: 'GET', path: 'c1', arg: { fields: 'status,effective_status' } });
  });

  it('returns zeros for empty insights', async () => {
    const { http } = fakeHttp({
      'GET c1/insights': JSON.parse(fixture('insights-empty.json')),
      'GET c1': JSON.parse(fixture('campaign-status-paused.json')),
    });
    expect(await metaStats(http, 'act_111', 'c1')).toEqual({ spendCents: 0, impressions: 0, clicks: 0, status: 'paused' });
  });

  it('maps a deleted campaign to removed', async () => {
    const { http } = fakeHttp({
      'GET c1/insights': JSON.parse(fixture('insights-empty.json')),
      'GET c1': JSON.parse(fixture('campaign-status-deleted.json')),
    });
    expect((await metaStats(http, 'act_111', 'c1')).status).toBe('removed');
  });

  it('maps archived to ended and unknown statuses to paused', async () => {
    const archived = fakeHttp({
      'GET c1/insights': JSON.parse(fixture('insights-empty.json')),
      'GET c1': { id: 'c1', status: 'ARCHIVED', effective_status: 'ARCHIVED' },
    });
    expect((await metaStats(archived.http, 'act_111', 'c1')).status).toBe('ended');
    const unknown = fakeHttp({
      'GET c1/insights': JSON.parse(fixture('insights-empty.json')),
      'GET c1': { id: 'c1', status: 'PAUSED', effective_status: 'WITH_ISSUES' },
    });
    expect((await metaStats(unknown.http, 'act_111', 'c1')).status).toBe('paused');
  });
});
