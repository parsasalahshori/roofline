import { migrate } from '../migrate.ts';
import { APP_ROLES, roleUrl, setRolePasswords } from '../roles.ts';

/** The URLs of one running test database. `owner` is the superuser, `tenant` is app_tenant, `system` is app_system. */
export type TestDatabase = {
  urls: { owner: string; tenant: string; system: string };
  stop(): Promise<void>;
};

/** Test-only role passwords. Real environments set theirs with `scripts/set-role-passwords.ts`. */
export const TEST_ROLE_PASSWORDS = { tenant: 'tenant-test-pw', system: 'system-test-pw' } as const;

/**
 * Starts one PostGIS container, applies every migration, sets the app role passwords, and returns
 * the owner, app_tenant and app_system URLs. The caller stops the container with `stop()`. The
 * vitest global setup uses this, and so can any other test that needs its own database.
 *
 * The postgis/postgis:16-3.4 image is amd64-only, so on Apple Silicon it runs under emulation and
 * takes a while to start. The platform is pinned so Docker never picks a different variant.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  // Loaded lazily: this file is re-exported by `@roofline/db/testing`, which the seed script and the
  // API test helpers import at runtime, and that must never load Testcontainers.
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
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
    return {
      urls: {
        owner,
        tenant: roleUrl(owner, APP_ROLES.tenant, TEST_ROLE_PASSWORDS.tenant),
        system: roleUrl(owner, APP_ROLES.system, TEST_ROLE_PASSWORDS.system),
      },
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    await container.stop();
    throw err;
  }
}
