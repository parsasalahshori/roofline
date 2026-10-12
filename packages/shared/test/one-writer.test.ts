import { readdirSync, readFileSync } from 'node:fs';
import { relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : tsFiles(full);
    return e.name.endsWith('.ts') ? [full] : [];
  });
}

test('only the agent-events repo inserts into agent_task_events', () => {
  const writers = ['packages/db/src', 'apps/api/src', 'apps/worker/src']
    .flatMap((d) => tsFiles(join(ROOT, d)))
    .filter((f) => /\.insert\(\s*agentTaskEvents/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(ROOT, f).split('\\').join('/'))
    .sort();
  expect(writers).toEqual(['packages/db/src/repos/agent-events.ts']);
});
