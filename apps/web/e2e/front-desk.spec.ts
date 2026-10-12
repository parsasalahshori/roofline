import { test, expect, readStack } from './fixtures.ts';
import {
  LEAK_CALLER,
  MARIA,
  ROOFLINE_NUMBER,
  seedFrontDesk,
  seedRooflineNumber,
  signedForwardedCall,
  TOM,
} from './front-desk-seed.ts';

/*
 * Front Desk from the browser, on the FAKE_PROVIDERS stack (D1 Task 27): the inbox, a call's
 * transcript with its action cards, a text reply through the send gate, "Team is handling", Mark as
 * spam, Settings (company facts, the transfer phone, the forwarding guide and test) and the dock
 * badge. The conversations are seeded rows (front-desk-seed.ts); nothing here reaches a provider.
 * Banners and toasts are found by their text (several role="status" regions are always mounted).
 */

const FRONT_DESK = 'Front Desk';

test('an empty inbox says calls will show up once forwarding is on', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/front-desk');
  await expect(page.getByRole('dialog', { name: FRONT_DESK })).toBeVisible();
  await expect(page.getByText('No calls yet. Once forwarding is on, every call shows up here.')).toBeVisible({
    timeout: 20_000,
  });
});

test('the inbox lists calls and texts, newest first, with live, unread and urgent states', async ({
  page,
  loginAs,
  markTodaySeen,
  pools,
  scenario,
}) => {
  await seedFrontDesk(pools, scenario);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/front-desk');

  const dialog = page.getByRole('dialog', { name: FRONT_DESK });
  await expect(dialog.getByRole('heading', { name: 'This week' })).toBeVisible({ timeout: 20_000 });
  // The AI minutes tile is this week's minutes alone, never set against the monthly allowance.
  for (const tile of ['Answered', 'Booked', 'Transferred', 'Messages', 'Spam', 'AI minutes this week']) {
    await expect(dialog.getByText(tile, { exact: true }).first()).toBeVisible();
  }

  // Newest first; the spam pitch is not in "All".
  const rows = dialog.getByRole('link');
  await expect(rows).toHaveCount(4, { timeout: 20_000 });
  await expect(rows.nth(0)).toContainText('Live now');
  await expect(rows.nth(1)).toContainText(TOM.name);
  await expect(rows.nth(1).getByRole('img', { name: '2 unread' })).toBeVisible();
  await expect(rows.nth(2)).toContainText(MARIA.name);
  await expect(rows.nth(2)).toContainText('Booked');
  await expect(rows.nth(3)).toContainText('Urgent');
  await expect(rows.nth(3)).toContainText('Message');

  const filter = (name: string) => dialog.getByRole('group', { name: 'Filter calls and texts' }).getByRole('button', { name, exact: true });

  await filter('Needs attention').click();
  await expect(filter('Needs attention')).toHaveAttribute('aria-pressed', 'true');
  await expect(rows).toHaveCount(3);
  await expect(dialog.getByText('Live now')).toHaveCount(0);

  await filter('Booked').click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(MARIA.name);

  await filter('Messages').click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(TOM.name);

  await filter('Spam').click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Spam');

  await filter('All').click();
  await expect(rows).toHaveCount(4);
});

test('a call opens with its disclosure, transcript, action cards and summary, and is marked read', async ({
  page,
  loginAs,
  markTodaySeen,
  pools,
  scenario,
  db,
}) => {
  const { ids } = await seedFrontDesk(pools, scenario);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/front-desk');

  const dialog = page.getByRole('dialog', { name: FRONT_DESK });
  await dialog.getByRole('link', { name: new RegExp(MARIA.name) }).click();
  await expect(page).toHaveURL(new RegExp(`/front-desk/${ids.maria}$`));

  await expect(dialog.getByRole('heading', { name: MARIA.name })).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByRole('heading', { name: 'What was said' })).toBeVisible();
  // The call opens with the recording disclosure, then the caller and the assistant take turns.
  await expect(dialog.getByText('this call is recorded', { exact: false })).toBeVisible();
  await expect(dialog.getByText('I found shingles in my yard', { exact: false })).toBeVisible();
  await expect(dialog.getByText('You are booked for Thursday at 10:00 AM.', { exact: false })).toBeVisible();
  // The booking shows as an action card.
  await expect(dialog.getByText('Booked an inspection', { exact: true })).toBeVisible();
  // Summary and the call back link.
  await expect(dialog.getByText('Maria booked an inspection for Thursday at 10:00 AM.', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Call back' })).toHaveAttribute('href', `tel:${MARIA.phone}`);
  // No stored recording was seeded, so there is nothing to play.
  await expect(dialog.getByRole('button', { name: 'Play recording' })).toHaveCount(0);

  await expect
    .poll(async () => (await db.query(`select unread_count from conversations where id = $1`, [ids.maria])).rows[0]?.unread_count, {
      timeout: 20_000,
    })
    .toBe(0);
});

test('the dock badge counts conversations that need attention and drops when one is opened', async ({
  page,
  loginAs,
  markTodaySeen,
  pools,
  scenario,
}) => {
  await seedFrontDesk(pools, scenario);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/');

  const dock = page.getByRole('navigation', { name: 'Apps' });
  // Maria, Tom and the urgent message are unread; the live call and the spam pitch are not.
  await expect(dock.getByRole('img', { name: '3 conversations waiting' })).toBeVisible({ timeout: 20_000 });

  await dock.getByRole('link', { name: FRONT_DESK, exact: false }).click();
  const dialog = page.getByRole('dialog', { name: FRONT_DESK });
  await dialog.getByRole('link', { name: new RegExp(TOM.name) }).click();
  await expect(dialog.getByRole('heading', { name: TOM.name })).toBeVisible({ timeout: 20_000 });

  await expect(dock.getByRole('img', { name: '2 conversations waiting' })).toBeVisible({ timeout: 20_000 });
});

test('a staff reply to a text goes out through the gate and leaves the assistant in charge; the switch hands it to the team and back', async ({
  page,
  loginAs,
  markTodaySeen,
  pools,
  scenario,
  db,
}) => {
  const { ids } = await seedFrontDesk(pools, scenario);
  await seedRooflineNumber(pools, db, scenario);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto(`/front-desk/${ids.tom}`);

  const dialog = page.getByRole('dialog', { name: FRONT_DESK });
  await expect(dialog.getByText('Hi, can someone look at my roof this week?')).toBeVisible({ timeout: 20_000 });
  const handling = dialog.getByRole('switch', { name: 'Team is handling' });
  await expect(handling).toHaveAttribute('aria-checked', 'false');

  const reply = 'We can be there Thursday morning.';
  await dialog.getByLabel('Your reply').fill(reply);
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(dialog.getByLabel('Your reply')).toHaveValue('');

  // The fake text adapter takes it: the message row ends up sent, on this conversation, to Tom.
  await expect
    .poll(
      async () =>
        (
          await db.query<{ status: string; to_e164: string }>(
            `select status, to_e164 from messages where conversation_id = $1 and direction = 'out' and body = $2`,
            [ids.tom, reply],
          )
        ).rows[0],
      { timeout: 20_000 },
    )
    .toEqual({ status: 'sent', to_e164: TOM.phone });

  // A reply does not hand the conversation over: the assistant only keeps quiet for a while after a
  // team text. The switch stays off once the conversation reloads after the reply.
  await page.reload();
  await expect(dialog.getByText('Hi, can someone look at my roof this week?')).toBeVisible({ timeout: 20_000 });
  await expect(handling).toHaveAttribute('aria-checked', 'false');
  const kept = await db.query<{ handled_by: string; team_until: Date | null }>(
    `select handled_by, team_until from conversations where id = $1`,
    [ids.tom],
  );
  expect(kept.rows[0]).toEqual({ handled_by: 'assistant', team_until: null });

  // The manual switch still hands it to the team (for two hours), and back.
  await handling.click();
  await expect(handling).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 });
  await expect
    .poll(
      async () => {
        const row = (await db.query<{ handled_by: string; team_until: Date | null }>(
          `select handled_by, team_until from conversations where id = $1`,
          [ids.tom],
        )).rows[0];
        return row ? { handledBy: row.handled_by, hasUntil: row.team_until !== null } : null;
      },
      { timeout: 20_000 },
    )
    .toEqual({ handledBy: 'team', hasUntil: true });

  await handling.click();
  await expect(handling).toHaveAttribute('aria-checked', 'false', { timeout: 20_000 });
  await expect
    .poll(async () => (await db.query(`select handled_by from conversations where id = $1`, [ids.tom])).rows[0]?.handled_by, {
      timeout: 20_000,
    })
    .toBe('assistant');

  // The inbox row shows who is handling a conversation.
  await handling.click();
  await expect(handling).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 });
  await page.goto('/front-desk');
  await expect(
    page
      .getByRole('dialog', { name: FRONT_DESK })
      .getByRole('link', { name: new RegExp(TOM.name) })
      .getByText('Team', { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
});

test('Mark as spam blocks the number and moves the call to the Spam filter', async ({
  page,
  loginAs,
  markTodaySeen,
  pools,
  scenario,
  db,
}) => {
  const { ids } = await seedFrontDesk(pools, scenario);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto(`/front-desk/${ids.leak}`);

  const dialog = page.getByRole('dialog', { name: FRONT_DESK });
  await expect(dialog.getByText('Water is coming through my ceiling', { exact: false })).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByText('Took a message for the team', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Mark as spam' }).click();
  await expect(dialog.getByText('Marked as spam', { exact: true })).toBeVisible({ timeout: 20_000 });

  const blocked = await db.query(`select 1 from blocked_numbers where company_id = $1 and e164 = $2`, [
    scenario.a.companyId,
    LEAK_CALLER.phone,
  ]);
  expect(blocked.rowCount).toBe(1);

  await page.goto('/front-desk');
  const filters = dialog.getByRole('group', { name: 'Filter calls and texts' });
  await expect(dialog.getByRole('link')).toHaveCount(3, { timeout: 20_000 });
  await filters.getByRole('button', { name: 'Spam', exact: true }).click();
  await expect(dialog.getByRole('link')).toHaveCount(2);
});

test('a field rep sees none of the owner conversations and has no Front Desk settings', async ({
  page,
  loginAs,
  markTodaySeen,
  pools,
  scenario,
}) => {
  const { ids } = await seedFrontDesk(pools, scenario);
  await loginAs(page, 'rep');
  await markTodaySeen(scenario.a.rep.email);

  // The seeded customers are nobody's own, and the rep is not on the call list.
  await page.goto('/front-desk');
  await expect(page.getByText('No calls yet. Once forwarding is on, every call shows up here.')).toBeVisible({
    timeout: 20_000,
  });

  await page.goto(`/front-desk/${ids.maria}`);
  await expect(page.getByText('We could not load this conversation.')).toBeVisible({ timeout: 20_000 });

  await page.goto('/settings/front-desk');
  await expect(page).toHaveURL(/\/settings\/company$/);
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('link', { name: 'Your profile' })).toBeVisible();
  await expect(settings.getByRole('link', { name: FRONT_DESK, exact: true })).toHaveCount(0);
});

test('Settings: the switch is blocked without a number, the owner must confirm before forwarding is verified, facts save, and bad numbers are refused', async ({
  page,
  loginAs,
  markTodaySeen,
  pools,
  scenario,
  db,
}) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/settings/front-desk');

  const settings = page.getByRole('dialog', { name: 'Settings' });
  const onOff = settings.getByRole('switch', { name: 'Front Desk answers my calls' });
  await expect(onOff).toBeDisabled({ timeout: 20_000 });
  await expect(settings.getByText('Add a business number first.')).toBeVisible();

  await seedRooflineNumber(pools, db, scenario);
  await page.reload();
  await expect(settings.getByText("Forwarding isn't verified yet.")).toBeVisible({ timeout: 20_000 });
  // The owner may turn it on before forwarding is verified, but only after a confirm; cancelling leaves it off.
  await expect(onOff).toBeEnabled({ timeout: 20_000 });
  await onOff.click();
  await expect(settings.getByText('Turn Front Desk on anyway?', { exact: false })).toBeVisible();
  await expect(settings.getByRole('region', { name: 'Turn on anyway' }).getByRole('button', { name: 'Turn on anyway' })).toBeVisible();
  await settings.getByRole('region', { name: 'Turn on anyway' }).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(settings.getByText('Turn Front Desk on anyway?', { exact: false })).toHaveCount(0);
  await expect(onOff).toHaveAttribute('aria-checked', 'false');

  const facts = settings.getByLabel('What the assistant should know about your company');
  const text = 'Open Monday to Friday, 8 to 5. We serve the whole county.';
  await facts.fill(text);
  await expect(settings.getByText(`${text.length} of 2000 characters`)).toBeVisible();
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.')).toBeVisible({ timeout: 20_000 });

  const saved = await db.query<{ front_desk_facts: string; front_desk_enabled: boolean }>(
    `select front_desk_facts, front_desk_enabled from company_settings where company_id = $1`,
    [scenario.a.companyId],
  );
  expect(saved.rows[0]).toEqual({ front_desk_facts: text, front_desk_enabled: false });

  await page.reload();
  await expect(settings.getByLabel('What the assistant should know about your company')).toHaveValue(text, { timeout: 20_000 });

  // A number outside its limits is refused next to the field and nothing is sent.
  const ring = settings.getByLabel('Ring my team first (seconds)');
  await ring.fill('99');
  await expect(settings.getByText('Enter a whole number from 0 to 30.')).toBeVisible();
  await ring.fill('10');
  await expect(settings.getByText('Enter a whole number from 0 to 30.')).toHaveCount(0);
});

test('Settings: your profile saves the transfer phone only with the recording acknowledgement', async ({
  page,
  loginAs,
  markTodaySeen,
  scenario,
  db,
}) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/settings/profile');

  const settings = page.getByRole('dialog', { name: 'Settings' });
  const phone = settings.getByLabel('Your phone number');
  const save = settings.getByRole('button', { name: 'Save', exact: true });
  const ack = settings.getByRole('checkbox', { name: 'I understand calls to this phone are recorded.' });

  await expect(phone).toBeVisible({ timeout: 20_000 });
  await phone.fill('(402) 555-0177');
  await expect(save).toBeDisabled();

  // A number that is not a US number is refused even with the box ticked.
  await phone.fill('12345');
  await ack.check();
  await save.click();
  await expect(settings.getByText('Enter a US phone number with its area code.')).toBeVisible();

  await phone.fill('(402) 555-0177');
  await save.click();
  await expect(page.getByText('Saved.')).toBeVisible({ timeout: 20_000 });
  await expect(phone).toHaveValue('+14025550177');

  const row = await db.query<{ transfer_phone_e164: string | null; recording_ack_at: Date | null }>(
    `select transfer_phone_e164, recording_ack_at from memberships where user_id = $1 and company_id = $2`,
    [scenario.a.owner.userId, scenario.a.companyId],
  );
  expect(row.rows[0]?.transfer_phone_e164).toBe('+14025550177');
  expect(row.rows[0]?.recording_ack_at).not.toBeNull();
});

test('Settings: the forwarding guide shows codes per carrier, and the test verifies, then Front Desk can be turned on', async ({
  page,
  loginAs,
  markTodaySeen,
  pools,
  scenario,
  db,
}) => {
  await seedRooflineNumber(pools, db, scenario);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/settings/front-desk');

  const settings = page.getByRole('dialog', { name: 'Settings' });
  const guide = settings.getByRole('region', { name: 'Send your calls to Front Desk' });
  await expect(guide).toBeVisible({ timeout: 20_000 });
  await expect(guide.getByText('Your business number', { exact: true })).toBeVisible();
  await expect(guide.getByText('Your Roofline number', { exact: true })).toBeVisible();

  const tenDigits = ROOFLINE_NUMBER.slice(2);
  await expect(guide.getByText(`*72${tenDigits}`, { exact: true })).toBeVisible();
  await expect(guide.getByText('*73', { exact: true })).toBeVisible();

  await guide.getByLabel('Your phone company').selectOption({ label: 'AT&T' });
  await expect(guide.getByText(`**21*${tenDigits}#`, { exact: true })).toBeVisible();
  await guide.getByLabel('Which calls').selectOption({ label: 'Forward calls I miss' });
  await expect(guide.getByText(`**61*${tenDigits}#`, { exact: true })).toBeVisible();
  await expect(guide.getByText('##61#', { exact: true })).toBeVisible();

  // Until the test passes, turning it on asks the owner to confirm (the override); nothing is switched yet.
  const onOff = settings.getByRole('switch', { name: 'Front Desk answers my calls' });
  await onOff.click();
  await expect(settings.getByRole('region', { name: 'Turn on anyway' }).getByRole('button', { name: 'Turn on anyway' })).toBeVisible();
  await settings.getByRole('region', { name: 'Turn on anyway' }).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(onOff).toHaveAttribute('aria-checked', 'false');

  await guide.getByRole('button', { name: 'Test it' }).click();
  await expect(guide.getByText('Calling your business number…')).toBeVisible({ timeout: 20_000 });

  // The fake call control placed the call; this is the business line forwarding it to the Roofline
  // number, signed the way Twilio signs it with the company's token.
  const forwarded = signedForwardedCall(readStack().testCallerNumber);
  const arrival = await page.request.post(forwarded.url, {
    form: forwarded.fields,
    headers: { 'X-Twilio-Signature': forwarded.signature },
  });
  expect(arrival.status()).toBe(200);
  expect(await arrival.text()).toContain('Forwarding works.');

  await expect(guide.getByText('Forwarding works', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(onOff).toBeEnabled({ timeout: 20_000 });
  await expect(settings.getByText("Forwarding isn't verified yet.")).toHaveCount(0);

  const setup = await page.request.get('/api/setup');
  const items = ((await setup.json()) as { items: { key: string; status: string }[] }).items;
  expect(items.find((item) => item.key === 'phone_number')?.status).toBe('done');

  // Verified: no confirm now, the switch simply turns on.
  await onOff.click();
  await expect(onOff).toHaveAttribute('aria-checked', 'true');
  await expect(settings.getByRole('region', { name: 'Turn on anyway' }).getByRole('button', { name: 'Turn on anyway' })).toHaveCount(0);
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.')).toBeVisible({ timeout: 20_000 });
  const enabled = await db.query<{ front_desk_enabled: boolean; forwarding_verified_at: Date | null }>(
    `select front_desk_enabled, forwarding_verified_at from company_settings where company_id = $1`,
    [scenario.a.companyId],
  );
  expect(enabled.rows[0]?.front_desk_enabled).toBe(true);
  expect(enabled.rows[0]?.forwarding_verified_at).not.toBeNull();
});

test('Settings: the office cannot turn Front Desk on before forwarding is verified; the owner can, with a confirm', async ({
  page,
  loginAs,
  markTodaySeen,
  pools,
  scenario,
  db,
}) => {
  await seedRooflineNumber(pools, db, scenario);
  await loginAs(page, 'office');
  await markTodaySeen('office@a.test');
  await page.goto('/settings/front-desk');

  const settings = page.getByRole('dialog', { name: 'Settings' });
  const onOff = settings.getByRole('switch', { name: 'Front Desk answers my calls' });
  await expect(settings.getByText("Forwarding isn't verified yet.")).toBeVisible({ timeout: 20_000 });
  await expect(onOff).toBeDisabled();

  await page.context().clearCookies();
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/settings/front-desk');
  await expect(onOff).toBeEnabled({ timeout: 20_000 });
  await onOff.click();
  await settings.getByRole('region', { name: 'Turn on anyway' }).getByRole('button', { name: 'Turn on anyway' }).click();
  await expect(onOff).toHaveAttribute('aria-checked', 'true');
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.')).toBeVisible({ timeout: 20_000 });

  const saved = await db.query<{ front_desk_enabled: boolean; forwarding_verified_at: Date | null }>(
    `select front_desk_enabled, forwarding_verified_at from company_settings where company_id = $1`,
    [scenario.a.companyId],
  );
  expect(saved.rows[0]).toEqual({ front_desk_enabled: true, forwarding_verified_at: null });
  // Once it is on, it can always be turned off again.
  await expect(onOff).toBeEnabled({ timeout: 20_000 });
});
