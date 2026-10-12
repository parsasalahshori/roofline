import { setRolePasswords } from '../src/roles.ts';

/*
 * Sets the app_tenant and app_system passwords after `migrate` (and app_hail's, when HAIL_DB_PASSWORD
 * is set; run after migrating 0018, which creates app_hail as NOLOGIN). The migration creates the roles
 * without passwords so no secret ever lands in the repo.
 *
 *   DATABASE_URL_OWNER=... TENANT_DB_PASSWORD=... SYSTEM_DB_PASSWORD=... [HAIL_DB_PASSWORD=...] npm run set-role-passwords -w @roofline/db
 */

const ownerUrl = process.env.DATABASE_URL_OWNER ?? 'postgres://roofline:roofline@127.0.0.1:54329/roofline';
const tenant = process.env.TENANT_DB_PASSWORD;
const system = process.env.SYSTEM_DB_PASSWORD;
const hail = process.env.HAIL_DB_PASSWORD || undefined;

if (!tenant || !system) {
  console.error('Set TENANT_DB_PASSWORD and SYSTEM_DB_PASSWORD (and DATABASE_URL_OWNER outside local dev).');
  process.exit(1);
}

await setRolePasswords(ownerUrl, { tenant, system, hail });
console.log(`Role passwords set for app_tenant and app_system${hail ? ' and app_hail' : ''}.`);
