import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.ts';

export type Schema = typeof schema;

/** A Drizzle database over a `pg.Pool`, with the schema loaded so `db.query.<table>` works. */
export type Db = NodePgDatabase<Schema>;

/**
 * The two connection pools the app uses. Neither connects as the table owner.
 * - `tenant` (app_tenant): all request work, always inside `withTenant`, subject to forced RLS.
 * - `system` (app_system): only `@roofline/db/system` functions (auth, webhook routing, scheduler
 *   fan-out). BYPASSRLS, but limited to the global tables plus a few scheduler columns.
 */
export type Pools = { tenant: Db; system: Db; end(): Promise<void> };

export function createPools(urls: { tenant: string; system: string }): Pools {
  const tenantPool = new pg.Pool({ connectionString: urls.tenant });
  const systemPool = new pg.Pool({ connectionString: urls.system });
  return {
    tenant: drizzle(tenantPool, { schema }),
    system: drizzle(systemPool, { schema }),
    async end() {
      await Promise.all([tenantPool.end(), systemPool.end()]);
    },
  };
}
