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
    await client.query(`truncate table ${rows.map((r) => r.name).join(', ')} restart identity cascade`);
  } finally {
    await client.end();
  }
}
