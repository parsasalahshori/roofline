import { defineConfig, devices } from '@playwright/test';

/*
 * End-to-end tests. `npx tsx e2e/stack.ts` starts the whole stack (PostGIS, API, worker) on port
 * 4410 and serves the built web app from it; `npm run e2e -w @roofline/web` builds first.
 * The swiftshader flags give headless Chromium WebGL, so MapLibre draws the pins.
 */
/** Chromium flags: software WebGL for the map, and `*.roofline.test` (company hosts) mapped to the stack. */
const LAUNCH_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--host-resolver-rules=MAP *.roofline.test 127.0.0.1'];

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4410',
    trace: 'retain-on-failure',
    launchOptions: {
      args: LAUNCH_ARGS,
      executablePath: process.env.PW_CHROMIUM_EXECUTABLE || undefined,
    },
  },
  webServer: {
    command: 'npx tsx e2e/stack.ts',
    url: 'http://127.0.0.1:4410/health',
    timeout: 300_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
      testIgnore: /(phone|doors|demo-walkthrough)\.spec/,
    },
    {
      name: 'phone',
      use: { ...devices['Pixel 7'], viewport: { width: 375, height: 812 } },
      testMatch: /(phone|doors)\.spec/,
    },
  ],
});
