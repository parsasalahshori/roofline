import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.ts';

export type Schema = typeof schema;

/** A Drizzle database over a `pg.Pool`, with the schema loaded so `db.query.<table>` works. */
export type Db = NodePgDatabase<Schema> & { $client: pg.Pool };

/**
 * The two connection pools the app uses. Neither connects as the table owner.
 * - `tenant` (app_tenant): all request work, always inside `withTenant`, subject to forced RLS.
 * - `system` (app_system): only `@roofline/db/system` functions (auth, webhook routing, scheduler
 *   fan-out). Not subject to the per-company filter (its app_system_all policies let every row
 *   through), but its grants limit it to the global tables plus a few scheduler columns.
 */
export type Pools = { tenant: Db; system: Db; end(): Promise<void> };

export type PoolName = 'tenant' | 'system';

export type PoolOptions = {
  /**
   * Called when an idle pooled connection fails (a database restart, a pooler dropping idle
   * connections). pg re-emits that on the Pool, and an 'error' event with no listener is an
   * uncaught exception, so a listener is always attached. Must not throw. The pool discards the
   * broken connection itself; the next query opens a new one.
   */
  onError?: (err: Error, which: PoolName) => void;
};

function logPoolError(err: Error, which: PoolName): void {
  console.error(`Idle ${which} database connection failed: ${err.message}`);
}

export function createPools(urls: { tenant: string; system: string }, opts: PoolOptions = {}): Pools {
  const onError = opts.onError ?? logPoolError;
  const open = (which: PoolName): Db => {
    const pool = new pg.Pool({ connectionString: urls[which] });
    pool.on('error', (err) => {
      try {
        onError(err, which);
      } catch {
        // A throwing handler would bring back the crash this listener exists to prevent.
      }
    });
    return drizzle(pool, { schema });
  };
  const tenant = open('tenant');
  const system = open('system');
  return {
    tenant,
    system,
    async end() {
      await Promise.all([tenant.$client.end(), system.$client.end()]);
    },
  };
}
