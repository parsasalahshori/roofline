import { mkdir } from 'node:fs/promises';
import type { Page, TestInfo } from '@playwright/test';
import type { Account, TaskView } from '../src/api/types.ts';
import { test, expect, readStack, setCompanyStatus } from './fixtures.ts';
import { seedRooflineNumber } from './front-desk-seed.ts';

// These use the existing throwaway PostGIS/API/worker stack and its FAKE_PROVIDERS=1 seams.
// The normal config discovers this file in desktop. Explicit viewport groups also exercise
// the exact 390x844 reference size without changing controller-owned Playwright configuration.
const sizes = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];

async function capture(page: Page, info: TestInfo, name: string) {
  if (!process.env.IRONCLAD_QA_SHOTS) return;
  await mkdir(process.env.IRONCLAD_QA_SHOTS, { recursive: true });
  const path = `${process.env.IRONCLAD_QA_SHOTS}/${name}-${page.viewportSize()?.width}.png`;
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: 'image/png' });
}

for (const viewport of sizes) {
  test.describe(`contract continuity at ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test('canceled company keeps billing recovery and can stop Front Desk without saving other settings', async ({
      page, loginAs, markTodaySeen, pools, db, scenario,
    }, info) => {
      await seedRooflineNumber(pools, db, scenario);
      await loginAs(page, 'owner');
      await markTodaySeen(scenario.a.owner.email);
      const headers = { Origin: readStack().baseUrl };
      const enabled = await page.request.put('/api/front-desk/settings', {
        headers, data: {
          enabled: true, override: true, facts: 'Original company facts.', texts: true, voice: 'claire',
          canMove: true, canCancel: false, ringTeamFirstSeconds: 10, missedCallTextBack: true,
          recordingRetentionDays: 30, transcriptRetentionDays: 90, maxConcurrentAiCalls: 3, onCallOrder: [],
        },
      });
      expect(enabled.status()).toBe(200);
      await setCompanyStatus('canceled');

      await page.goto('/settings/front-desk');
      const toggle = page.getByRole('switch', { name: 'Front Desk answers my calls' });
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await page.getByLabel('What the assistant should know about your company').fill('Must not persist while canceled.');
      await toggle.click();
      const saved = page.waitForResponse((response) => response.url().endsWith('/api/front-desk/settings') && response.request().method() === 'PUT');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      expect((await saved).status()).toBe(200);
      await page.reload();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect(page.getByLabel('What the assistant should know about your company')).toHaveValue('Original company facts.');
      const reenable = await page.request.put('/api/front-desk/settings', { headers, data: { enabled: true, override: true } });
      expect(reenable.status()).toBe(403);
      const transfer = await page.request.put('/api/me/transfer-phone', { headers, data: { e164: '+14025550123', ackRecording: true } });
      expect(transfer.status()).toBe(403);
      const create = await page.request.post('/api/customers', { headers, data: { displayName: 'Must not be saved' } });
      expect(create.status()).toBe(403);
      await page.getByRole('link', { name: 'Pick a plan to keep going' }).click();
      await expect(page).toHaveURL(/\/settings\/billing$/);
      await expect(page.getByRole('heading', { name: 'Plans', exact: true })).toBeVisible();
      await capture(page, info, 'canceled-billing');
    });

    test('stale approval shows conflict, then uses current versions and retains owner-only spend', async ({
      page, loginAs, markTodaySeen, scenario,
    }, info) => {
      await loginAs(page, 'office');
      await markTodaySeen(scenario.a.office.email);
      await page.goto(`/approvals/${scenario.taskId}`);
      const approve = page.getByRole('button', { name: /^Approve 2 steps/ });
      await expect(approve).toBeVisible();
      const taskResponse = await page.request.get(`/api/approvals/${scenario.taskId}`);
      expect(taskResponse.status()).toBe(200);
      const initial = await taskResponse.json() as TaskView;
      const message = initial.steps.find((step) => step.approvalClass === 'message')!;
      const spend = initial.steps.find((step) => step.approvalClass === 'spend')!;
      expect(spend.canApprove).toBe(false);
      // Simulate another tab changing the server after this screen loaded, without intercepting HTTP.
      const changed = await page.request.patch(`/api/approvals/${initial.id}/steps/${message.id}`, {
        headers: { Origin: readStack().baseUrl }, data: { version: message.version, enabled: true },
      });
      expect(changed.status()).toBe(200);
      const newer = await changed.json() as { version: number };
      expect(newer.version).toBeGreaterThan(message.version);
      const conflict = page.waitForResponse((response) => response.url().endsWith('/approve') && response.status() === 409);
      await approve.click();
      const failed = await conflict;
      const failure = await failed.json() as { error: string };
      await expect(page.getByText(failure.error, { exact: true })).toBeVisible();
      const posted = page.waitForRequest((request) => request.url().endsWith('/approve') && request.method() === 'POST');
      await approve.click();
      expect((await posted).postDataJSON()).toEqual({ steps: initial.steps.map((step) => ({
        id: step.id, version: step.id === message.id ? newer.version : step.version,
      })) });
      await expect.poll(async () => {
        const response = await page.request.get(`/api/approvals/${initial.id}`);
        const task = await response.json() as TaskView;
        return task.steps.find((step) => step.id === spend.id)?.status;
      }).toBe('awaiting_owner');
      await expect(page.getByRole('dialog').getByRole('listitem').filter({ hasText: spend.preview.title })).toContainText('Waiting for owner');
      await capture(page, info, 'office-approval');
    });

    test('switching company from a detail removes old data and old URLs cannot expose it', async ({
      page, loginAs, markTodaySeen, db, scenario,
    }, info) => {
      // Add the existing synthetic owner to the existing second test company only.
      const other = await db.query<{ id: string }>("select id from companies where slug = 'bolt-roofing'");
      const companyId = other.rows[0]!.id;
      await db.query("insert into memberships (company_id, user_id, role) values ($1, $2, 'owner')", [companyId, scenario.a.owner.userId]);
      await loginAs(page, 'owner');
      await markTodaySeen(scenario.a.owner.email);
      await page.goto(`/approvals/${scenario.taskId}`);
      await expect(page.getByRole('heading', { name: 'Storm plan: hail on the north side' })).toBeVisible();
      const me = await (await page.request.get('/api/auth/me')).json() as Account;
      let switched = false;
      const lateDetailReads: string[] = [];
      page.on('response', (response) => {
        if (response.url().endsWith('/api/auth/switch-company') && response.ok()) switched = true;
      });
      page.on('request', (request) => {
        if (switched && request.url().endsWith(`/api/approvals/${scenario.taskId}`)) lateDetailReads.push(request.method());
      });
      await page.getByRole('button', { name: me.user.name, exact: true }).click();
      await page.getByRole('button', { name: 'Switch to Bolt Roofing', exact: true }).click();
      await expect(page).toHaveURL('/');
      await expect(page.getByRole('heading', { name: 'Storm plan: hail on the north side' })).toHaveCount(0);
      expect(await (await page.request.get('/api/auth/me')).json()).toMatchObject({ company: { id: companyId } });
      const lateReadsAtSwitch = [...lateDetailReads];
      expect((await page.request.get(`/api/approvals/${scenario.taskId}`)).status()).toBe(404);
      await page.goto(`/approvals/${scenario.taskId}`);
      await expect(page.getByText("This page isn't here", { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Approve/ })).toHaveCount(0);
      await capture(page, info, 'company-isolation');
      expect(lateReadsAtSwitch, 'old-company details must unmount before query reset').toEqual([]);
    });
  });
}

test('the non-demo stack has no simulation controls or simulation mutation routes', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Apps' })).toBeVisible();
  expect(await (await page.request.get('/api/demo')).json()).toEqual({ demo: false });
  await expect(page.getByTestId('demo-badge')).toHaveCount(0);
  for (const kind of ['text', 'call', 'storm', 'sign']) {
    const response = await page.request.post(`/api/demo/simulate/${kind}`, { headers: { Origin: readStack().baseUrl }, data: {} });
    expect(response.status(), kind).toBe(404);
  }
});
