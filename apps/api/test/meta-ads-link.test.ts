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
    const { http, calls } = fakeHttp({ 'GET act_111': new AdPlatformError('access', 403) });
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
      'POST act_111/assigned_users': new AdPlatformError('access', 400),
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
      'POST act_111/assigned_users': new AdPlatformError('access', 400),
    });
    expect(JSON.stringify(await verifyAccess(http, 'act_111', 'sys-1'))).not.toMatch(/Graph|message|error/i);
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
