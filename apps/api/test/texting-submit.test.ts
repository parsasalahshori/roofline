import pg from 'pg';
import { afterEach, beforeEach, describe, expect, inject, test } from 'vitest';
import { plainRejection } from '@roofline/shared';
import { advanceRegistration } from '../src/account/texting/advance.ts';
import { MESSAGES } from '../src/errors.ts';
import { policyUrls } from '../src/public/policy-urls.ts';
import { loginAs, makeTestApp, type TestApp } from './helpers.ts';

const NO_CARD_TEXT = 'Add a card first. Texting registration has a carrier fee.';
const ALREADY_WAITING_TEXT = 'Your registration is already with the phone carriers.';
const STATUS_CALLBACK = 'https://app.roofline.test/hooks/twilio-registration';
const FEE_DESCRIPTION = 'Texting registration: business check';

const BRAND = {
  legalName: 'Acme Roofing LLC',
  ein: '12-3456789',
  businessType: 'llc',
  street: '1200 Farnam St',
  city: 'Omaha',
  state: 'NE',
  zip: '68102',
  website: 'https://acme.com',
  contactFirstName: 'Maria',
  contactLastName: 'Lopez',
  contactEmail: 'maria@acme.test',
  contactPhone: '(402) 555-0199',
  contactTitle: 'Owner',
};

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
  // The seed gives every company an approved registration row. These tests start from none.
  await ownerQuery('delete from texting_registrations where company_id = $1', [t.seed.a.companyId]);
});

afterEach(async () => {
  await t.close();
});

/** Runs SQL as the owner role, which bypasses row-level security. */
async function ownerQuery<R extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<R[]> {
  const client = new pg.Client({ connectionString: inject('dbUrls').owner });
  await client.connect();
  try {
    const res = await client.query<R>(sql, params);
    return res.rows;
  } finally {
    await client.end();
  }
}

/** Gives Acme a card: the company has a subscription and is active. */
async function addCard(): Promise<void> {
  await ownerQuery("update companies set stripe_subscription_id = 'sub_test', status = 'active' where id = $1", [
    t.seed.a.companyId,
  ]);
}

function submitBody(brand: Record<string, unknown> = BRAND) {
  return { brand, useHostedPolicyPages: false };
}

/** The arguments of each submitBrand call the fake registrar took, in order (the brand options). */
function brandSubmissions(): Record<string, unknown>[] {
  return t.registrar.calls.filter((c) => c.method === 'submitBrand').map((c) => c.args[1] as Record<string, unknown>);
}

describe('texting registration submit', () => {
  test('submitting needs the owner, a confirmed email and a card', async () => {
    const office = await loginAs(t.app, t.seed.a.office);
    const byOffice = await office.post('/api/texting/registration').send(submitBody());
    expect(byOffice.status).toBe(403);
    expect(byOffice.body.error).toBe(MESSAGES.roleCannot);

    const owner = await loginAs(t.app, t.seed.a.owner);
    await ownerQuery('update users set email_verified_at = null where id = $1', [t.seed.a.owner.userId]);
    const unverified = await owner.post('/api/texting/registration').send(submitBody());
    expect(unverified.status).toBe(403);
    expect(unverified.body.error).toBe(MESSAGES.verifyEmailFirst);

    await ownerQuery('update users set email_verified_at = now() where id = $1', [t.seed.a.owner.userId]);
    const noCard = await owner.post('/api/texting/registration').send(submitBody());
    expect(noCard.status).toBe(403);
    expect(noCard.body.error).toBe(NO_CARD_TEXT);

    expect(t.jobs.sent).toEqual([]);
  });

  test('submit saves, queues and answers waiting', async () => {
    await addCard();
    const owner = await loginAs(t.app, t.seed.a.owner);

    const res = await owner.post('/api/texting/registration').send(submitBody());

    expect(res.status).toBe(202);
    expect(res.body.state).toBe('waiting');
    expect(t.jobs.sent).toMatchObject([{ name: 'texting-registration', data: { companyId: t.seed.a.companyId } }]);
  });

  test('the hosted policy pages fill an empty website with the full privacy URL', async () => {
    await addCard();
    const owner = await loginAs(t.app, t.seed.a.owner);
    const privacy = policyUrls(t.deps.config, 'acme-roofing').privacy;

    const res = await owner.post('/api/texting/registration').send({ brand: { ...BRAND, website: '' }, useHostedPolicyPages: true });
    expect(res.status).toBe(202);
    await t.jobs.drain(t.deps);

    const saved = await ownerQuery<{ brand_info: { website: string } }>('select brand_info from texting_registrations where company_id = $1', [t.seed.a.companyId]);
    expect(saved[0]!.brand_info.website).toBe(privacy);
    expect(brandSubmissions()[0]).toMatchObject({ website: privacy });
  });

  test('a second submit while waiting is refused', async () => {
    await addCard();
    const owner = await loginAs(t.app, t.seed.a.owner);
    expect((await owner.post('/api/texting/registration').send(submitBody())).status).toBe(202);

    const again = await owner.post('/api/texting/registration').send(submitBody());

    expect(again.status).toBe(409);
    expect(again.body.error).toBe(ALREADY_WAITING_TEXT);
  });

  test('the job submits the brand and records the fee once', async () => {
    const companyId = t.seed.a.companyId;
    await addCard();
    const owner = await loginAs(t.app, t.seed.a.owner);
    expect((await owner.post('/api/texting/registration').send(submitBody())).status).toBe(202);

    await t.jobs.drain(t.deps);

    const submissions = brandSubmissions();
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({ statusCallback: STATUS_CALLBACK });

    const fees = await ownerQuery<{ unit_cost_cents: string; description: string }>(
      "select unit_cost_cents, description from usage_events where company_id = $1 and kind = 'texting_registration_fee'",
      [companyId],
    );
    expect(fees).toHaveLength(1);
    expect(Number(fees[0]!.unit_cost_cents)).toBe(4400);
    expect(fees[0]!.description).toBe(FEE_DESCRIPTION);

    // The brand is already submitted: a second run does nothing, so it records no second fee.
    await advanceRegistration(t.deps, companyId);
    await t.jobs.drain(t.deps);

    expect(brandSubmissions()).toHaveLength(1);
    const feesAfter = await ownerQuery(
      "select id from usage_events where company_id = $1 and kind = 'texting_registration_fee'",
      [companyId],
    );
    expect(feesAfter).toHaveLength(1);
  });

  test('a refused brand needs a fix', async () => {
    await addCard();
    t.registrar.failNext('submitBrand', { rejected: 'EIN does not match' });
    const owner = await loginAs(t.app, t.seed.a.owner);
    expect((await owner.post('/api/texting/registration').send(submitBody())).status).toBe(202);

    await t.jobs.drain(t.deps);

    const view = await owner.get('/api/texting');
    expect(view.status).toBe(200);
    expect(view.body.state).toBe('needs_fix');
    expect(view.body.rejectedFields).toEqual(['legalName', 'ein']);
    expect(view.body.reason).toBe(plainRejection('EIN does not match').reason);
  });

  test('fix and resubmit sends the previous ids', async () => {
    const companyId = t.seed.a.companyId;
    await addCard();
    const owner = await loginAs(t.app, t.seed.a.owner);
    expect((await owner.post('/api/texting/registration').send(submitBody())).status).toBe(202);
    await t.jobs.drain(t.deps);

    const [stored] = await ownerQuery<{
      customer_profile_sid: string;
      trust_product_sid: string;
      brand_sid: string;
    }>('select customer_profile_sid, trust_product_sid, brand_sid from texting_registrations where company_id = $1', [
      companyId,
    ]);
    expect(stored!.brand_sid).toBeTruthy();

    // A brand failure after review: the carriers rejected the brand itself.
    await ownerQuery(
      "update texting_registrations set brand_status = 'failed', campaign_status = 'rejected' where company_id = $1",
      [companyId],
    );

    const fixed = { ...BRAND, legalName: 'Acme Roofing Company LLC' };
    const resubmitted = await owner.post('/api/texting/registration').send(submitBody(fixed));
    expect(resubmitted.status).toBe(202);
    await t.jobs.drain(t.deps);

    const submissions = brandSubmissions();
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toMatchObject({
      previous: {
        customerProfileSid: stored!.customer_profile_sid,
        trustProductSid: stored!.trust_product_sid,
        brandSid: stored!.brand_sid,
      },
    });
  });

  test('the form defaults come from the company', async () => {
    await ownerQuery(
      `update companies set legal_name = null, address_street = '1200 Farnam St', address_city = 'Omaha',
         address_state = 'NE', address_zip = '68102', website = 'https://acme.com' where id = $1`,
      [t.seed.a.companyId],
    );
    const owner = await loginAs(t.app, t.seed.a.owner);

    const res = await owner.get('/api/texting');

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('not_started');
    expect(res.body.needsPaymentMethod).toBe(true);
    expect(res.body.needsVerifiedEmail).toBe(false);
    expect(res.body.defaults).toMatchObject({
      legalName: 'Acme Roofing',
      street: '1200 Farnam St',
      city: 'Omaha',
      state: 'NE',
      zip: '68102',
      website: 'https://acme.com',
      contactEmail: t.seed.a.owner.email,
      contactPhone: '+14025550199',
    });
    expect(res.body.hostedPolicyUrls).toEqual(policyUrls(t.deps.config, 'acme-roofing'));
  });

  test('a field error names the brand field', async () => {
    await addCard();
    const owner = await loginAs(t.app, t.seed.a.owner);

    const res = await owner.post('/api/texting/registration').send(submitBody({ ...BRAND, ein: '12' }));

    expect(res.status).toBe(400);
    expect(res.body.field).toBe('brand.ein');
    expect(t.jobs.sent).toEqual([]);
  });
});
