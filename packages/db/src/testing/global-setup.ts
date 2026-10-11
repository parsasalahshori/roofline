import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { migrate } from '../migrate.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Connection URLs for the one Testcontainer this run shares. `owner` is the superuser that owns the tables. */
    dbUrls: { owner: string };
  }
}

/**
 * Vitest `globalSetup`: starts one PostGIS container, applies every migration, and shares the
 * owner URL with the tests through `inject('dbUrls')`. Task 4 adds the app_tenant and app_system URLs.
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

  const owner = container.getConnectionUri();
  await migrate(owner);
  project.provide('dbUrls', { owner });

  return async () => {
    await container.stop();
  };
}
