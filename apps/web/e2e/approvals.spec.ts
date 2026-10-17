import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';
import { seedOldLead, seedTextsPlan, seedWeatherMovePlan } from './g1-seeds.ts';

/*
 * The review window (R2): approving a draft in two clicks from the map pill or the Storm window,
 * turning a step off, and the office user whose spend step waits for the owner. Steps are found
 * by their title inside the review dialog; statuses are counted inside the step list only.
 */

/** The step row for one step title inside the review dialog. */
function row(page: Page, title: string) {
  return page.getByRole('main').getByRole('listitem').filter({ hasText: title });
}

test('one draft: pill to approved in 2 clicks', async ({ page, loginAs, markTodaySeen, click, clicks }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/');
  await click(page.getByRole('link', { name: '1 needs your OK' }));
  await click(page.getByRole('button', { name: 'Approve 3 steps · up to $270' }));
  // Scoped to the step list: once every step is done the task's own status in the stat strip also reads "Done".
  await expect(page.getByRole('main').getByRole('list').getByText('Done', { exact: true })).toHaveCount(3, {
    timeout: 15_000,
  });
  expect(clicks.count).toBe(2);
});

test('from the Storm window: 2 clicks', async ({ page, loginAs, markTodaySeen, scenario, click, clicks }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/storm');
  await click(page.getByRole('link', { name: 'Review 3 steps' }));
  await expect(page).toHaveURL(new RegExp('/storm/plans/' + scenario.taskId + '$'));
  await click(page.getByRole('button', { name: 'Approve 3 steps · up to $270' }));
  await expect(page.getByRole('main').getByRole('list').getByText('Done', { exact: true })).toHaveCount(3, {
    timeout: 15_000,
  });
  expect(clicks.count).toBe(2);
});

test('turning a step off excludes it', async ({ page, loginAs, markTodaySeen, scenario }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/approvals/' + scenario.taskId);

  // Toggling a switch is not one of the two counted approval clicks, so it uses page directly.
  const doorKnock = page.getByRole('switch', { name: 'Door-knock routes for 4 reps' });
  await doorKnock.click();
  await expect(doorKnock).toHaveAttribute('aria-checked', 'false');

  await page.getByRole('button', { name: 'Approve 2 steps · up to $270' }).click();
  await expect(row(page, 'Door-knock routes for 4 reps')).toContainText('Turned off', { timeout: 15_000 });
  await expect(row(page, 'Text 31 customers')).toContainText('Done', { timeout: 15_000 });
  await expect(row(page, 'Google + Facebook ads on the swath')).toContainText('Done', { timeout: 15_000 });
});

test('office approves two, the ad waits for the owner', async ({ page, loginAs, markTodaySeen, scenario }) => {
  await loginAs(page, 'office');
  await markTodaySeen('office@a.test');
  await page.goto('/approvals/' + scenario.taskId);

  await expect(row(page, 'Google + Facebook ads on the swath')).toContainText('Your owner approves spending');
  await page.getByRole('button', { name: 'Approve 2 steps · send ad to owner' }).click();

  // No reload: the review picks up the live result of the approval.
  await expect(row(page, 'Text 31 customers')).toContainText('Done', { timeout: 15_000 });
  await expect(row(page, 'Door-knock routes for 4 reps')).toContainText('Done', { timeout: 15_000 });
  await expect(row(page, 'Google + Facebook ads on the swath')).toContainText('Waiting for owner', { timeout: 15_000 });

  // The owner signs in and sees the one step left to approve.
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/');
  await page.getByRole('link', { name: '1 needs your OK' }).click();
  await expect(page.getByRole('button', { name: 'Approve 1 step · up to $270' })).toBeVisible();
});

/*
 * The queue (/approvals): the plans as cards, and the keys of a triage list. A plan with one step to decide is approved
 * right on the queue; a plan with several opens its review, where each step has its switch.
 */

const WEATHER_TITLE = 'Rain on the install day: move 1 install?';

test('queue: the keys move between cards, 1 approves a one-step plan and opens the review of a bigger one', async ({
  page,
  loginAs,
  markTodaySeen,
  scenario,
  db,
  pools,
}) => {
  const move = await seedWeatherMovePlan(pools, db, scenario.a.companyId);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/approvals');

  const list = page.getByRole('list', { name: 'Plans waiting for your OK' });
  const weather = list.getByRole('article', { name: WEATHER_TITLE });
  await expect(weather).toBeVisible({ timeout: 15_000 });
  // The storm plan has three steps to decide: its main button opens the review
  const storm = list.getByRole('article').filter({ has: page.getByRole('link', { name: 'Review 3 steps' }) });
  await expect(storm.getByRole('link', { name: 'Review 3 steps' })).toHaveAttribute('href', new RegExp('/approvals/' + scenario.taskId + '$'));
  // What it reaches and what it costs, from the plan itself
  await expect(storm).toContainText('31 texts');
  await expect(storm).toContainText('Up to $270');

  // J goes to the first card (the newest plan, the weather move), J again to the next, K back
  await page.keyboard.press('j');
  await expect(weather.getByRole('button', { name: 'Approve' })).toBeFocused();
  await page.keyboard.press('j');
  await expect(storm.getByRole('link', { name: 'Review 3 steps' })).toBeFocused();
  await page.keyboard.press('k');
  await expect(weather.getByRole('button', { name: 'Approve' })).toBeFocused();

  // 1 on the one-step plan approves it: the card leaves the queue and says so
  await page.keyboard.press('1');
  await expect(page.getByText('Approved: ' + WEATHER_TITLE)).toBeVisible({ timeout: 15_000 });
  await expect(list.getByRole('article', { name: WEATHER_TITLE })).toHaveCount(0, { timeout: 15_000 });
  await expect
    .poll(async () => (await db.query<{ status: string }>('select status from agent_tasks where id = $1', [move.taskId])).rows[0]?.status, {
      timeout: 20_000,
    })
    .not.toBe('draft');

  // The focus went to the plan that took its place; 1 there opens its review
  await expect(storm.getByRole('link', { name: 'Review 3 steps' })).toBeFocused();
  await page.keyboard.press('1');
  await expect(page).toHaveURL(new RegExp('/approvals/' + scenario.taskId + '$'));
  await expect(page.getByRole('button', { name: 'Approve 3 steps · up to $270' })).toBeVisible();
});

test('queue: H sets a plan aside with a reason, E edits a plan with one text to change', async ({
  page,
  loginAs,
  markTodaySeen,
  scenario,
  db,
  pools,
}) => {
  const lead = await seedOldLead(db, scenario.a.companyId);
  const texts = await seedTextsPlan(pools, scenario.a.companyId, lead.customerId);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/approvals');

  const card = page.getByRole('article', { name: 'Follow up with 1 lead' });
  await expect(card).toBeVisible({ timeout: 15_000 });

  // E fetches the plan and opens the step's own sheet right there
  await card.getByRole('button', { name: 'Approve' }).focus();
  await page.keyboard.press('e');
  const edit = page.getByRole('dialog', { name: 'Edit this step' });
  await expect(edit).toBeVisible({ timeout: 15_000 });
  await expect(edit.getByRole('textbox').first()).toHaveValue(/Would Tuesday at 10 AM/);
  await edit.getByRole('button', { name: 'Cancel' }).click();
  await expect(edit).toHaveCount(0);

  // H asks for a reason, then sets the plan aside
  await card.getByRole('button', { name: 'Approve' }).focus();
  await page.keyboard.press('h');
  const sheet = page.getByRole('dialog', { name: 'Set this plan aside?' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('textbox', { name: 'Why not? (optional)' }).fill('Customer called to reschedule');
  await sheet.getByRole('button', { name: 'Not now' }).click();
  await expect(page.getByText("Okay, we've set this plan aside.")).toBeVisible({ timeout: 15_000 });
  await expect(card).toHaveCount(0, { timeout: 15_000 });
  const row = await db.query<{ status: string }>('select status from agent_tasks where id = $1', [texts.taskId]);
  expect(row.rows[0]?.status).toBe('declined');
});

test.describe('queue on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('cards run the full width, their buttons are 44px tall and nothing scrolls sideways', async ({
    page,
    loginAs,
    markTodaySeen,
    scenario,
    db,
    pools,
  }) => {
    await seedWeatherMovePlan(pools, db, scenario.a.companyId);
    await loginAs(page, 'owner');
    await markTodaySeen('owner@a.test');
    await page.goto('/approvals');

    const cards = page.getByRole('list', { name: 'Plans waiting for your OK' }).getByRole('article');
    await expect(cards.first()).toBeVisible({ timeout: 15_000 });
    expect(await cards.count()).toBeGreaterThanOrEqual(2);

    for (const card of await cards.all()) {
      const box = await card.boundingBox();
      // The screen's 16px margins on both sides, give or take a rounded edge
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(390 - 2 * 16 - 2);
      for (const button of await card.getByRole('button').all()) {
        expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      }
      for (const link of await card.getByRole('link', { name: /^Review/ }).all()) {
        expect((await link.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test('a card header is one line: the tag the page already says is left to screen readers', async ({
    page,
    loginAs,
    markTodaySeen,
    scenario,
    db,
    pools,
  }) => {
    await seedWeatherMovePlan(pools, db, scenario.a.companyId);
    await loginAs(page, 'owner');
    await markTodaySeen('owner@a.test');
    await page.goto('/approvals');

    const cards = page.getByRole('list', { name: 'Plans waiting for your OK' }).getByRole('article');
    await expect(cards.first()).toBeVisible({ timeout: 15_000 });
    for (const card of await cards.all()) {
      // The agent's line, the glyph and (not on a phone) the tag: one line of 22px glyph, not a header of two lines of words
      const header = await card.locator('header').boundingBox();
      expect(header?.height ?? 0).toBeLessThanOrEqual(30);
      // The tag is still there for a screen reader, clipped to a point
      const tag = card.getByText('Needs your OK');
      await expect(tag).toHaveCount(1);
      const box = await tag.boundingBox();
      expect(box?.width ?? 0).toBeLessThanOrEqual(2);
    }
  });

  test('the review: the decision bar is under the Measure tile, and each step switch has a 44px target', async ({
    page,
    loginAs,
    markTodaySeen,
    scenario,
  }) => {
    await loginAs(page, 'owner');
    await markTodaySeen('owner@a.test');
    await page.goto('/approvals/' + scenario.taskId);
    await expect(page.getByRole('button', { name: /^Approve 3 steps/ })).toBeVisible({ timeout: 15_000 });

    // The tile stands up out of the tab bar over the bar's foot: the point just inside its top edge belongs to the tile, not to the bar
    const hit = await page.evaluate(() => {
      const tile = document.querySelector('nav [data-tab="measure"]');
      if (!tile) return null;
      const glyph = tile.firstElementChild?.getBoundingClientRect();
      if (!glyph) return null;
      const found = document.elementFromPoint(glyph.left + glyph.width / 2, glyph.top + 3);
      return { insideTile: found !== null && tile.contains(found), tag: found?.tagName ?? null };
    });
    expect(hit).not.toBeNull();
    expect(hit?.insideTile).toBe(true);

    // The visible switch is 44 by 24; the button around it is the target
    for (const toggle of await page.getByRole('switch').all()) {
      const box = await toggle.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe('the queue on a desktop', () => {
  test('the cards of a row are as tall as each other and keep their buttons on one line', async ({
    page,
    loginAs,
    markTodaySeen,
    scenario,
    db,
    pools,
  }) => {
    await seedWeatherMovePlan(pools, db, scenario.a.companyId);
    await loginAs(page, 'owner');
    await markTodaySeen('owner@a.test');
    await page.goto('/approvals');

    const cards = page.getByRole('list', { name: 'Plans waiting for your OK' }).getByRole('article');
    await expect(cards.first()).toBeVisible({ timeout: 15_000 });
    expect(await cards.count()).toBeGreaterThanOrEqual(2);
    const boxes = await Promise.all((await cards.all()).map((card) => card.boundingBox()));
    const buttons = await Promise.all((await cards.all()).map((card) => card.locator('[data-role="approve"]').boundingBox()));
    // Cards that share a row (the same top) are the same height and their Approve buttons sit on the same line
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        if (Math.abs(a.y - b.y) > 1) continue;
        expect(Math.abs(a.height - b.height)).toBeLessThanOrEqual(1);
        expect(Math.abs((buttons[i]?.y ?? 0) - (buttons[j]?.y ?? 0))).toBeLessThanOrEqual(1);
      }
    }
  });
});

test.describe('a card in a narrow column', () => {
  // Home holds the card in a column of 340 to 404px beside the map, on a page as wide as any desktop: no phone rules apply
  for (const width of [340, 404]) {
    test(`at ${width}px the facts and the buttons wrap, nothing sticks out and the drafted line is whole`, async ({
      page,
      loginAs,
      markTodaySeen,
      scenario,
      db,
      pools,
    }) => {
      await seedWeatherMovePlan(pools, db, scenario.a.companyId);
      await loginAs(page, 'owner');
      await markTodaySeen('owner@a.test');
      await page.goto('/approvals');

      const cards = page.getByRole('list', { name: 'Plans waiting for your OK' }).getByRole('article');
      await expect(cards.first()).toBeVisible({ timeout: 15_000 });
      expect(await cards.count()).toBeGreaterThanOrEqual(2);
      await cards.evaluateAll((all, columnWidth) => {
        for (const card of all as HTMLElement[]) {
          card.style.width = columnWidth + 'px';
          card.style.justifySelf = 'start';
        }
      }, width);

      // The shell hides sideways overflow and each card clips its own, so a page-width check cannot see a card that spills:
      // every box inside a card is measured against the card
      const problems = await cards.evaluateAll((all) => {
        const found: string[] = [];
        for (const card of all) {
          const box = card.getBoundingClientRect();
          const name = card.querySelector('h3')?.textContent ?? 'a card';
          if (card.scrollWidth > card.clientWidth + 1) found.push(`${name}: the card scrolls sideways`);
          for (const element of card.querySelectorAll('*')) {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            // Text that is there for a screen reader only is clipped to a point on purpose
            if (rect.width === 0 || rect.height === 0 || style.clip !== 'auto') continue;
            if (rect.right > box.right + 0.5 || rect.left < box.left - 0.5) {
              found.push(`${name}: <${element.tagName.toLowerCase()}> "${(element.textContent ?? '').trim().slice(0, 30)}" sticks out of the card`);
            }
            if (style.textOverflow === 'ellipsis' && element.scrollWidth > element.clientWidth + 1) {
              found.push(`${name}: "${(element.textContent ?? '').trim()}" is cut with an ellipsis`);
            }
          }
        }
        return found;
      });
      expect(problems).toEqual([]);

      // The buttons share a row when they fit and wrap when they do not: none is narrower than its own words
      for (const card of await cards.all()) {
        for (const button of await card.getByRole('button').all()) {
          const fits = await button.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
          expect(fits).toBe(true);
        }
      }
    });
  }
});

test.describe('the trail in a tight top bar', () => {
  test.use({ viewport: { width: 768, height: 900 } });

  test('a long plan title gives way with an ellipsis and the link up the trail keeps its words', async ({ page, loginAs, markTodaySeen, scenario }) => {
    await loginAs(page, 'owner');
    await markTodaySeen('owner@a.test');
    await page.goto('/approvals/' + scenario.taskId);
    const trail = page.getByRole('navigation', { name: 'Breadcrumb' });
    const parent = trail.getByRole('link').first();
    await expect(parent).toBeVisible({ timeout: 15_000 });

    // Make the page's own crumb far too long for the bar. A page with a long title does this for real.
    await trail.locator('[aria-current="page"]').evaluate((element) => {
      element.textContent = 'A plan whose name runs on and on and on and on and on and on and on and on and on and on and on';
    });

    const measured = await trail.evaluate((nav) => {
      const link = nav.querySelector('a');
      const separator = nav.querySelector('li[aria-hidden="true"]');
      const here = nav.querySelector('[aria-current="page"]');
      if (!link || !separator || !here) return null;
      return {
        // The link's words end before the separator begins; a negative gap is the separator drawn over them
        gap: separator.getBoundingClientRect().left - link.getBoundingClientRect().right,
        hereCut: here.scrollWidth > here.clientWidth,
      };
    });
    expect(measured).not.toBeNull();
    expect(measured!.gap).toBeGreaterThanOrEqual(0);
    expect(measured!.hereCut).toBe(true);
  });
});
