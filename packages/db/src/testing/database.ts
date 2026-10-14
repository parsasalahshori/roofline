import { migrate } from '../migrate.ts';
import { APP_ROLES, roleUrl, setRolePasswords } from '../roles.ts';

/** The URLs of one running test database. `owner` is the superuser, `tenant` is app_tenant, `system` is app_system. */
export type TestDatabase = {
  urls: { owner: string; tenant: string; system: string };
  stop(): Promise<void>;
};

/** Test-only role passwords. Real environments set theirs with `scripts/set-role-passwords.ts`. */
export const TEST_ROLE_PASSWORDS = { tenant: 'tenant-test-pw', system: 'system-test-pw' } as const;

/** Explicit local opt-in; keep CI's existing image and architecture unless requested. */
export function testPostgisImage(value = process.env['ROOFLINE_TEST_POSTGIS_IMAGE']) {
  const image = value ?? 'postgis/postgis:16-3.4';
  if (image !== 'postgis/postgis:16-3.4' && image !== 'imresamu/postgis:16-3.4') {
    throw new Error('ROOFLINE_TEST_POSTGIS_IMAGE must be postgis/postgis:16-3.4 or imresamu/postgis:16-3.4');
  }
  return image;
}

/**
 * Starts one PostGIS container, applies every migration, sets the app role passwords, and returns
 * the owner, app_tenant and app_system URLs. The caller stops the container with `stop()`. The
 * vitest global setup uses this, and so can any other test that needs its own database.
 *
 * Default: postgis/postgis:16-3.4, pinned to linux/amd64, preserving existing CI behavior.
 * Local Apple Silicon runs may set ROOFLINE_TEST_POSTGIS_IMAGE=imresamu/postgis:16-3.4
 * to use the native variant of the same PG16/PostGIS3.4 image already used by the demo.
 * Only these two images are allowed. These opt-ins do not affect production or demo configuration.
 * ROOFLINE_TEST_DB_IN_MEMORY=1 places this disposable container's data in a 512 MiB tmpfs.
 * This avoids local Docker disk latency without changing PostgreSQL fsync settings. Data disappears
 * when the container stops; runs exceeding the memory-backed volume capacity fail normally.
 * Both options are unset by default, preserving CI storage and image behavior.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  // Loaded lazily: this file is re-exported by `@roofline/db/testing`, which the seed script and the
  // API test helpers import at runtime, and that must never load Testcontainers.
  const image = testPostgisImage();
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const builder = new PostgreSqlContainer(image);
  if (image === 'postgis/postgis:16-3.4') builder.withPlatform('linux/amd64');
  if (process.env['ROOFLINE_TEST_DB_IN_MEMORY'] === '1') {
    builder.withTmpFs({ '/var/lib/postgresql/data': 'rw,size=512m' });
  }
  const container = await builder
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
