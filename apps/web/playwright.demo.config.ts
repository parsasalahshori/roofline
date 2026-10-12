import { defineConfig, devices } from '@playwright/test';

/*
 * The demo smoke test (e2e/demo-walkthrough.spec.ts), kept apart from the e2e suite:
 *
 *   npx playwright test -c apps/web/playwright.demo.config.ts
 *
 * The webServer is `npm run demo:reset` itself (scripts/demo.ts) on port 4510 with its own compose
 * project and database port, so it never touches a demo the presenter is running: a fresh database,
 * the Summit Ridge Roofing seed, and the API + worker with DEMO_MODE=1. Headless and without video
 * by default; DEMO_VIDEO=1 records one (into demo-artifacts/run, git-ignored) and DEMO_SLOWMO=300
 * slows it down for watching.
 */
const LAUNCH_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const SIZE = { width: 1440, height: 900 };

export default defineConfig({
  testDir: 'e2e',
  testMatch: /demo-walkthrough\.spec\.ts/,
  outputDir: '../../demo-artifacts/run',
  workers: 1,
  retries: 0,
  timeout: 10 * 60_000,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4510',
    trace: 'off',
    video: process.env.DEMO_VIDEO ? { mode: 'on', size: SIZE } : 'off',
    launchOptions: {
      args: LAUNCH_ARGS,
      slowMo: Number(process.env.DEMO_SLOWMO ?? 0),
      executablePath: process.env.PW_CHROMIUM_EXECUTABLE || undefined,
    },
  },
  webServer: {
    command: 'npx tsx ../../scripts/demo.ts --reset',
    url: 'http://127.0.0.1:4510/health',
    timeout: 600_000,
    reuseExistingServer: !!process.env.DEMO_REUSE,
    env: { DEMO_PORT: '4510', DEMO_DB_PORT: '54349', DEMO_COMPOSE_PROJECT: 'roofline-demo-smoke' },
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: SIZE } }],
});
