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
 * The postgis/postgis:16-3.4 image is amd64-only, so on arm64 (Apple Silicon) the tests use the
 * multi-arch imresamu/postgis:16-3.4 instead: the same PG16 and PostGIS 3.4 the demo runs on, native
 * rather than emulated (Ruling DM1). TEST_POSTGIS_IMAGE overrides the choice. The platform is pinned
 * so Docker never picks a different variant.
 */
const AMD64_IMAGE = 'postgis/postgis:16-3.4';
const MULTI_ARCH_IMAGE = 'imresamu/postgis:16-3.4';

function testImage(): { image: string; platform: string } {
  const platform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
  const chosen = process.env.TEST_POSTGIS_IMAGE?.trim();
  if (chosen) return { image: chosen, platform };
  return process.arch === 'arm64' ? { image: MULTI_ARCH_IMAGE, platform } : { image: AMD64_IMAGE, platform };
}

export async function startTestDatabase(): Promise<TestDatabase> {
  // Loaded lazily: this file is re-exported by `@roofline/db/testing`, which the seed script and the
  // API test helpers import at runtime, and that must never load Testcontainers.
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const { image, platform } = testImage();
  const container = await new PostgreSqlContainer(image)
    .withPlatform(platform)
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
