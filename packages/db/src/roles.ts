import pg from 'pg';

/** The login roles the roles_rls migration creates. Their passwords are never in a migration. */
export const APP_ROLES = { tenant: 'app_tenant', system: 'app_system' } as const;

/**
 * Sets the app_tenant and app_system passwords (`ALTER ROLE ... PASSWORD`). Run as the migration
 * owner after `migrate`. ALTER ROLE takes no bind parameters, so each password is sent as an
 * escaped literal.
 */
export async function setRolePasswords(ownerUrl: string, passwords: { tenant: string; system: string }): Promise<void> {
  for (const [key, value] of Object.entries(passwords)) {
    if (!value) throw new Error(`The ${key} role password is empty.`);
  }
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query(`alter role ${APP_ROLES.tenant} with password ${client.escapeLiteral(passwords.tenant)}`);
    await client.query(`alter role ${APP_ROLES.system} with password ${client.escapeLiteral(passwords.system)}`);
  } finally {
    await client.end();
  }
}

/** The owner's connection URL with the user and password swapped for an app role's. */
export function roleUrl(ownerUrl: string, role: string, password: string): string {
  const url = new URL(ownerUrl);
  url.username = encodeURIComponent(role);
  url.password = encodeURIComponent(password);
  return url.toString();
}
