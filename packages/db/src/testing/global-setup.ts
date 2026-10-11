import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { migrate } from '../migrate.ts';
import { APP_ROLES, roleUrl, setRolePasswords } from '../roles.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    /**
     * Connection URLs for the one Testcontainer this run shares.
     * - `owner`: the superuser that owns the tables (bypasses even forced RLS, so seeding works).
     * - `tenant`: app_tenant, subject to RLS.
     * - `system`: app_system, through RLS on its app_system_all policies but with limited grants.
     */
    dbUrls: { owner: string; tenant: string; system: string };
  }
}

/** Test-only role passwords. Real environments set theirs with `scripts/set-role-passwords.ts`. */
const TEST_ROLE_PASSWORDS = { tenant: 'tenant-test-pw', system: 'system-test-pw' } as const;

/**
 * Vitest `globalSetup`: starts one PostGIS container, applies every migration, sets the app role
 * passwords, and shares the owner, app_tenant and app_system URLs with the tests through
 * `inject('dbUrls')`.
 *
 * The postgis/postgis:16-3.4 image is amd64-only, so on Apple Silicon it runs under emulation and
 * takes a while to start. The platform is pinned so Docker never picks a different variant.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withPlatform('linux/amd64')
    .withDatabase('roofline')
    .withUsername('roofline')
    .withPassword('roofline')
    .withStartupTimeout(180_000)
    .start();

  try {
    const owner = container.getConnectionUri();
    await migrate(owner);
    await setRolePasswords(owner, TEST_ROLE_PASSWORDS);
    project.provide('dbUrls', {
      owner,
      tenant: roleUrl(owner, APP_ROLES.tenant, TEST_ROLE_PASSWORDS.tenant),
      system: roleUrl(owner, APP_ROLES.system, TEST_ROLE_PASSWORDS.system),
    });
  } catch (err) {
    await container.stop();
    throw err;
  }

  return async () => {
    await container.stop();
  };
}
