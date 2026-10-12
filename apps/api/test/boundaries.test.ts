import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, test } from 'vitest';

/*
 * The import boundary for @roofline/db/system (the app_system pool: its RLS policies let it see
 * every company). Only auth, the Twilio hooks, the scheduler jobs, the scripts, the worker and the db
 * package itself may import it; everything else reaches the database through `withTenant`.
 *
 * These tests run the repo's real ESLint config (eslint.config.js) on source text, with a
 * `filePath` that pretends the text lives at each location. Nothing is written into src/.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const eslint = new ESLint({ cwd: ROOT });

const BAD_FIXTURE = readFileSync(new URL('./fixtures/imports-db-system.ts', import.meta.url), 'utf8');

/** The `no-restricted-imports` messages ESLint reports for `source` when it sits at `repoPath`. */
async function restrictedImports(repoPath: string, source: string = BAD_FIXTURE): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath: `${ROOT}${repoPath}` });
  return result!.messages.filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message);
}

describe('@roofline/db/system import boundary', () => {
  test('a route importing it is a lint error', async () => {
    const found = await restrictedImports('apps/api/src/routes/__fixture_bad_import.ts');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/@roofline\/db\/system/);
  });

  test.each([
    'apps/api/src/hooks/__fixture_ok_import.ts',
    'apps/api/src/auth/__fixture_ok_import.ts',
    'apps/api/src/jobs/scheduler/__fixture_ok_import.ts',
    'apps/api/src/account/__fixture_ok_import.ts',
    'apps/api/src/public/__fixture_ok_import.ts',
    'apps/api/src/scripts/__fixture_ok_import.ts',
    'apps/worker/src/__fixture_ok_import.ts',
    'packages/db/src/__fixture_ok_import.ts',
    'packages/db/test/__fixture_ok_import.ts',
    'apps/api/test/__fixture_ok_import.ts',
    'packages/send-gate/test/__fixture_ok_import.ts',
  ])('%s may import it', async (path) => {
    expect(await restrictedImports(path)).toEqual([]);
  });

  test.each([
    'apps/api/src/routes/customers.ts',
    'apps/api/src/routes/imports.ts',
    'apps/api/src/messaging/dispatcher.ts',
    'apps/api/src/tasks/runner.ts',
    'apps/api/src/jobs/worker.ts',
    'apps/api/src/permissions.ts',
    'apps/api/src/app.ts',
    'packages/send-gate/src/decide.ts',
    'packages/shared/src/pricing.ts',
  ])('%s may not', async (path) => {
    expect(await restrictedImports(path)).toHaveLength(1);
  });

  test.each([
    ["import '@roofline/db/system';", 'a bare import'],
    ["import type { Pools } from '@roofline/db/system';", 'a type-only import'],
    ["export { findCompanyBySlug } from '@roofline/db/system';", 'a re-export'],
    ["export * from '@roofline/db/system';", 'an export-all'],
    ["import * as system from '@roofline/db/system'; export { system };", 'a namespace import'],
    ["import { x } from '@roofline/db/system/auth'; export { x };", 'a deeper path'],
    ["import { x } from '../../../../packages/db/src/system/index.ts'; export { x };", 'a relative path into the db package'],
    ["import { x } from '../../../../packages/db/src/system'; export { x };", 'a relative path to the folder'],
  ])('%s is caught (%s)', async (source) => {
    expect(await restrictedImports('apps/api/src/routes/__fixture_bad_import.ts', source)).toHaveLength(1);
  });

  test('the db package itself and the other entry points are not restricted', async () => {
    const source = "import { createPools } from '@roofline/db'; import { resetDb } from '@roofline/db/testing'; export { createPools, resetDb };";
    expect(await restrictedImports('apps/api/src/routes/__fixture_bad_import.ts', source)).toEqual([]);
  });

  test('the fixture is clean where it really is (test files may import it)', async () => {
    const [result] = await eslint.lintFiles(['apps/api/test/fixtures/imports-db-system.ts']);
    expect(result!.messages).toEqual([]);
  });
});

describe('agent event writer boundary', () => {
  const src = (name: string) => `import { ${name} } from '@roofline/db'; export { ${name} };`;

  test.each(['insertAgentEvent', 'setStepSnapshot'])('%s is allowed in tasks/service.ts and tests, flagged elsewhere in src', async (name) => {
    expect(await restrictedImports('apps/api/src/tasks/service.ts', src(name))).toEqual([]);
    expect(await restrictedImports('apps/api/test/__fixture_ok.ts', src(name))).toEqual([]);
    expect(await restrictedImports('apps/api/src/routes/agents-feed.ts', src(name))).toHaveLength(1);
    expect(await restrictedImports('apps/api/src/agents/recount.ts', src(name))).toHaveLength(1);
    expect(await restrictedImports('apps/api/src/auth/__fixture_bad.ts', src(name))).toHaveLength(1);
  });

  test.each(['rewriteStepSnapshot', 'refreshTaskMinutes'])('%s is allowed in agents/recount.ts and tests, flagged elsewhere in src', async (name) => {
    expect(await restrictedImports('apps/api/src/agents/recount.ts', src(name))).toEqual([]);
    expect(await restrictedImports('apps/api/test/__fixture_ok.ts', src(name))).toEqual([]);
    expect(await restrictedImports('apps/api/src/tasks/service.ts', src(name))).toHaveLength(1);
    expect(await restrictedImports('apps/api/src/routes/agents-settings.ts', src(name))).toHaveLength(1);
    expect(await restrictedImports('apps/api/src/jobs/scheduler/__fixture_bad.ts', src(name))).toHaveLength(1);
  });

  test.each(['finishClaimedStep', 'finishParkedStep', 'expireOverdueDrafts'])(
    '%s (a raw step or draft finisher) is allowed in tasks/service.ts and tests, flagged elsewhere in src',
    async (name) => {
      expect(await restrictedImports('apps/api/src/tasks/service.ts', src(name))).toEqual([]);
      expect(await restrictedImports('apps/api/test/__fixture_ok.ts', src(name))).toEqual([]);
      expect(await restrictedImports('apps/api/src/estimator/exact-report-complete.ts', src(name))).toHaveLength(1);
      expect(await restrictedImports('apps/api/src/jobs/scheduler/exact-report-poll.ts', src(name))).toHaveLength(1);
      expect(await restrictedImports('apps/api/src/messaging/dispatcher.ts', src(name))).toHaveLength(1);
      expect(await restrictedImports('apps/api/src/tasks/runner.ts', src(name))).toHaveLength(1);
    },
  );

  test('the relative form into the db package source is flagged too', async () => {
    const source = "import { insertAgentEvent } from '../../../../packages/db/src/index.ts'; export { insertAgentEvent };";
    expect(await restrictedImports('apps/api/src/routes/agents-feed.ts', source)).toHaveLength(1);
  });

  test('other @roofline/db imports are not restricted', async () => {
    const source = "import { withTenant } from '@roofline/db'; export { withTenant };";
    expect(await restrictedImports('apps/api/src/routes/agents-feed.ts', source)).toEqual([]);
  });

  test('files that may import @roofline/db/system still may, and other src files still may not', async () => {
    expect(await restrictedImports('apps/api/src/auth/__fixture_ok_import.ts')).toEqual([]);
    expect(await restrictedImports('apps/api/src/tasks/service.ts')).toHaveLength(1);
    expect(await restrictedImports('apps/api/src/agents/recount.ts')).toHaveLength(1);
  });
});
