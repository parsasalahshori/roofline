import { afterEach, describe, expect, inject, test, vi } from 'vitest';
import { createPools, type Pools } from '../src/pools.ts';

const urls = inject('dbUrls');

// pg re-emits an idle client's error on its Pool. Emitting 'error' directly is exactly that event;
// with no listener, EventEmitter would throw it as an uncaught exception.
const idleError = (message: string) => Object.assign(new Error(message), { code: '57P01' });

describe('createPools error listeners', () => {
  let pools: Pools | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await pools?.end();
    pools = undefined;
  });

  test('an idle-connection error on either pool reaches onError with the pool name and never throws', () => {
    const onError = vi.fn();
    pools = createPools({ tenant: urls.tenant, system: urls.system }, { onError });
    const tenantErr = idleError('terminating connection due to administrator command');
    const systemErr = idleError('server closed the connection unexpectedly');

    expect(() => pools!.tenant.$client.emit('error', tenantErr)).not.toThrow();
    expect(() => pools!.system.$client.emit('error', systemErr)).not.toThrow();

    expect(onError.mock.calls).toEqual([
      [tenantErr, 'tenant'],
      [systemErr, 'system'],
    ]);
  });

  test('the default handler logs with console.error and never throws', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    pools = createPools({ tenant: urls.tenant, system: urls.system });

    expect(() => pools!.tenant.$client.emit('error', idleError('boom tenant'))).not.toThrow();
    expect(() => pools!.system.$client.emit('error', idleError('boom system'))).not.toThrow();

    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[0]![0])).toMatch(/tenant.*boom tenant/);
    expect(String(log.mock.calls[1]![0])).toMatch(/system.*boom system/);
  });

  test('a handler that throws still does not crash the process', () => {
    pools = createPools(
      { tenant: urls.tenant, system: urls.system },
      {
        onError: () => {
          throw new Error('handler bug');
        },
      },
    );
    expect(() => pools!.tenant.$client.emit('error', idleError('x'))).not.toThrow();
  });

  test('the pools still serve queries after an idle-connection error', async () => {
    pools = createPools({ tenant: urls.tenant, system: urls.system }, { onError: () => {} });
    pools.tenant.$client.emit('error', idleError('dropped'));
    const res = await pools.tenant.$client.query<{ who: string }>('select current_user as who');
    expect(res.rows).toEqual([{ who: 'app_tenant' }]);
  });
});
