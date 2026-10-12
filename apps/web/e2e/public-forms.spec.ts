import { test, expect, companyHostUrl, unsubscribeTokenFor } from './fixtures.ts';

/*
 * The two public forms in a real browser (Ruling BF): the storm landing page's request form and the
 * email unsubscribe page. Both are plain HTML forms, so the browser decides the Origin it sends; it
 * sends the real one only because the pages answer `Referrer-Policy: same-origin` (helmet's default
 * no-referrer makes it `Origin: null`, which the Origin guards refuse). Nothing is stubbed: each
 * submit is a real click, and what it recorded is read back from the database.
 */

const PAGE_CODE = 'abcd2345';

test('storm landing page form submits in a browser with a real Origin', async ({ page, scenario, db }) => {
  // The page row is inserted directly (the owner role bypasses row-level security); the plan flow is proven in other specs.
  await db.query(
    `insert into storm_pages (company_id, company_storm_id, code, active_until) values ($1, $2, $3, now() + interval '30 days')`,
    [scenario.a.companyId, scenario.companyStormId, PAGE_CODE],
  );

  const response = await page.goto(companyHostUrl('/storm/' + PAGE_CODE));
  expect(response?.headers()['referrer-policy']).toBe('same-origin');

  await page.getByLabel('Name', { exact: true }).fill('Form Origin');
  await page.getByLabel('Mobile phone').fill('4025550177');
  await page.getByLabel('Address of the home to inspect').fill('7421 Cedar Ridge Dr, Omaha, NE 68114');
  await page.getByRole('button', { name: 'Request a free inspection' }).click();

  await expect(page).toHaveURL(new RegExp('/storm/' + PAGE_CODE + '/thanks$'));
  await expect(page.getByRole('heading', { name: 'Thanks, we got your request' })).toBeVisible();

  const lead = await db.query<{ stage: string; source: string }>(
    `select j.stage, j.source from jobs j join customers c on c.id = j.customer_id
      where j.company_id = $1 and c.display_name = 'Form Origin'`,
    [scenario.a.companyId],
  );
  expect(lead.rows).toEqual([{ stage: 'lead', source: 'web' }]);
  const requests = await db.query(`select 1 from storm_requests where company_id = $1`, [scenario.a.companyId]);
  expect(requests.rowCount).toBe(1);
});

test('unsubscribe link records the opt-out from a real click, and a second visit is harmless', async ({
  page,
  scenario,
  db,
}) => {
  const email = 'pat.unsub@example.com';
  const path = '/u/' + unsubscribeTokenFor(scenario.a.companyId, email);
  const optOuts = () =>
    db.query<{ email: string }>(`select email from email_opt_outs where company_id = $1`, [scenario.a.companyId]);

  const response = await page.goto(path);
  expect(response?.headers()['referrer-policy']).toBe('same-origin');
  // Opening the link records nothing (mail scanners prefetch links).
  await expect(page.getByRole('heading', { name: 'Unsubscribe', exact: true })).toBeVisible();
  expect((await optOuts()).rowCount).toBe(0);

  await page.getByRole('button', { name: 'Unsubscribe', exact: true }).click();
  const done = page.getByRole('heading', { name: 'You are unsubscribed from ' + scenario.a.name });
  await expect(done).toBeVisible();
  expect((await optOuts()).rows).toEqual([{ email }]);

  // A second visit and click: the same confirmation, and still exactly one row.
  await page.goto(path);
  await page.getByRole('button', { name: 'Unsubscribe', exact: true }).click();
  await expect(done).toBeVisible();
  expect((await optOuts()).rows).toEqual([{ email }]);
});
