import type { TestProject } from 'vitest/node';
import { startTestDatabase } from './database.ts';

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

/**
 * Vitest `globalSetup`: calls `startTestDatabase` (one PostGIS container, every migration applied,
 * app role passwords set) and shares the owner, app_tenant and app_system URLs with the tests through
 * `inject('dbUrls')`. The returned teardown stops the container.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const database = await startTestDatabase();
  try {
    project.provide('dbUrls', database.urls);
  } catch (err) {
    await database.stop();
    throw err;
  }

  return async () => {
    await database.stop();
  };
}
