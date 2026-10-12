import pg from 'pg';

/**
 * Truncates every table in the public schema (`RESTART IDENTITY CASCADE`), so each test starts
 * from an empty database. Tables that belong to an extension, such as PostGIS's `spatial_ref_sys`
 * reference data, are left alone, and so is the migration history (it lives in the `drizzle` schema).
 */
export async function resetDb(ownerUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ name: string }>(
      `select format('%I.%I', n.nspname, c.relname) as name
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind in ('r', 'p')
          and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
        order by 1`,
    );
    if (rows.length === 0) return;
    await truncateWithRetry(client, `truncate table ${rows.map((r) => r.name).join(', ')} restart identity cascade`);
  } finally {
    await client.end();
  }
}

/**
 * Runs the truncate, retrying when Postgres picks it as the deadlock victim (40P01) up to 5 attempts
 * with a 100 ms x attempt backoff. A worker transaction in the e2e stack (its crons keep running) can hold
 * row locks on tables the truncate needs; a deadlock victim truncated nothing, so it is safe to try again.
 */
export async function truncateWithRetry(client: Pick<pg.Client, 'query'>, sql: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await client.query(sql);
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== '40P01' || attempt >= 5) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}
