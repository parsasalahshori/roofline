import { expect, type Page, test } from '@playwright/test';

/*
 * The demo smoke test: signs in to Summit Ridge Roofing (the demo seed), tours every app and runs
 * each simulation from the Demo badge's panel. Run it with the demo config, which starts the demo
 * itself (scripts/demo.ts --reset):
 *
 *   npx playwright test -c apps/web/playwright.demo.config.ts
 *
 * The main e2e config ignores this file.
 */

const LOGIN = { email: 'owner@summitridge.test', password: 'summit-ridge-demo' };

/** Lets the viewer look at a screen for a moment (and gives the screen's queries time to land). */
async function linger(page: Page, ms = 1500): Promise<void> {
  await page.waitForTimeout(ms);
}

/** Opens a path and waits for the window to settle. */
async function visit(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await linger(page);
}

/** Clicks the first visible match, if there is one; a tour step never fails on an optional click. */
async function clickFirst(page: Page, selector: string): Promise<boolean> {
  const target = page.locator(selector).first();
  if (!(await target.isVisible().catch(() => false))) return false;
  await target.click();
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await linger(page);
  return true;
}

/** Opens the Demo badge's simulate panel and presses one simulation; it must succeed. */
async function simulate(page: Page, which: 'text' | 'call' | 'storm' | 'sign'): Promise<void> {
  const panel = page.getByTestId('simulate-panel');
  if (!(await panel.isVisible().catch(() => false))) await page.getByTestId('demo-badge').click();
  await expect(panel).toBeVisible();
  const responded = page.waitForResponse((r) => r.url().includes(`/api/demo/simulate/${which}`), { timeout: 60_000 });
  await page.getByTestId(`simulate-${which}`).click();
  const response = await responded;
  expect(response.status(), `simulate ${which}`).toBeLessThan(300);
  await linger(page, 2000);
}

test('Roofline demo walkthrough', async ({ page }) => {

  await test.step('Sign in', async () => {
    await page.goto('/sign-in');
    await linger(page, 800);
    await page.getByLabel('Email').fill(LOGIN.email);
    await page.getByLabel('Password').fill(LOGIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByTestId('demo-badge')).toBeVisible({ timeout: 30_000 });
    await linger(page, 2500);
  });

  await test.step('Map and CRM', async () => {
    await visit(page, '/');
    await visit(page, '/customers');
    await clickFirst(page, 'main a[href^="/customers/"]:not([href$="/new"])');
    await visit(page, '/jobs');
    await clickFirst(page, 'main a[href^="/jobs/"]:not([href$="/new"])');
  });

  await test.step('Estimator and proposals', async () => {
    await visit(page, '/estimator');
    await clickFirst(page, 'main a[href^="/estimator/proposals/"]');
  });

  await test.step('Storm Scout', async () => {
    await visit(page, '/storm');
    await clickFirst(page, 'main a[href^="/storm/"]:not([href^="/storm/routes"])');
  });

  await test.step('Front Desk', async () => {
    await visit(page, '/front-desk');
    await clickFirst(page, 'main a[href^="/front-desk/"]');
  });

  await test.step('Calendar', async () => {
    await visit(page, '/calendar');
  });

  await test.step('Agents', async () => {
    await visit(page, '/agents');
    await visit(page, '/agents/feed');
    await visit(page, '/agents/claims');
    await visit(page, '/agents/scheduler');
    await visit(page, '/agents/follow-up');
    await visit(page, '/approvals');
  });

  await test.step('Simulate: a homeowner texts in', async () => {
    await visit(page, '/front-desk');
    await simulate(page, 'text');
    await visit(page, '/front-desk');
  });

  await test.step('Simulate: an incoming call', async () => {
    await simulate(page, 'call');
    await visit(page, '/front-desk');
    await clickFirst(page, 'main a[href^="/front-desk/"]');
  });

  await test.step('Simulate: a hail storm hits', async () => {
    await visit(page, '/storm');
    await simulate(page, 'storm');
    await visit(page, '/storm');
  });

  await test.step('Simulate: a homeowner signs', async () => {
    await visit(page, '/estimator');
    await simulate(page, 'sign');
    await visit(page, '/estimator');
    await visit(page, '/agents/feed');
  });

});
