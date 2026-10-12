import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { DEFAULT_STORM_EMAIL_BODY, DEFAULT_STORM_EMAIL_SUBJECT, DEFAULT_STORM_SMS } from '@roofline/shared';
import { loginAs, makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

const NOT_ALLOWED = "Your role can't do that. Ask the owner.";
const NOT_FOUND = "We couldn't find that.";
const HAIL = 'Please pick a hail size from 0.75 to 2 inches, in quarter-inch steps.';
const BUDGET = 'Please enter a budget between $10 and $10,000.';
const DAYS = 'Please enter a number of days between 1 and 30.';
const SHARE = 'Please choose a share between 0 and 100.';
const PHOTO_TYPE = 'Please use a JPEG or PNG photo.';
const PHOTO_EMPTY = 'Please choose a photo.';
const PHOTO_FULL = 'You can add up to 5 photos. Remove one first.';
const PHOTO_TOO_BIG = 'That photo is too big. Please use one under 5 MB.';

/** A JPEG starts FF D8 FF; the rest is filler the server stores as it is. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('roof-photo-jpeg')]);
/** A PNG starts with the eight-byte PNG signature. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('roof-photo-png')]);

/** Text that keeps every token the SMS and email rules ask for. */
const CUSTOM_SMS = 'Hi {first_name}, {company} here. Radar shows hail up to {hail_size} near {street}. Reply STOP to opt out.';
const CUSTOM_EMAIL = 'Hail hit {street}. {company}, {company_address}. {unsubscribe}';

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
});

/** A look at the stored settings row through the system pool, so a reset shows as NULL. */
async function storedSettings(companyId: string): Promise<Record<string, unknown>> {
  const result = await t.deps.pools.system.$client.query(
    'select hail_threshold_in, storm_ad_budget_cents, storm_ad_days, storm_ad_google_share_pct, storm_email_enabled, storm_sms_template, storm_email_subject, storm_email_template from company_settings where company_id = $1',
    [companyId],
  );
  return result.rows[0] as Record<string, unknown>;
}

function upload(agent: SuperAgent, bytes: Buffer, type = 'image/jpeg') {
  return agent.post('/api/storm/photos').set('Content-Type', type).send(bytes);
}

/** Reads a response as raw bytes; supertest would otherwise drop an image body. */
const binary = (
  res: unknown,
  done: (err: Error | null, body: Buffer) => void,
): void => {
  const chunks: Buffer[] = [];
  const stream = res as NodeJS.ReadableStream;
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => done(null, Buffer.concat(chunks)));
  stream.on('error', (err: Error) => done(err, Buffer.alloc(0)));
};

describe('storm settings', () => {
  test('storm settings round-trip: defaults then a saved change', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const first = await owner.get('/api/storm/settings');
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      thresholdIn: 1,
      adBudgetCents: 27000,
      adDays: 7,
      adGoogleSharePct: 55,
      emailEnabled: true,
      smsTemplate: DEFAULT_STORM_SMS,
      emailSubject: DEFAULT_STORM_EMAIL_SUBJECT,
      emailTemplate: DEFAULT_STORM_EMAIL_BODY,
      defaults: {
        smsTemplate: DEFAULT_STORM_SMS,
        emailSubject: DEFAULT_STORM_EMAIL_SUBJECT,
        emailTemplate: DEFAULT_STORM_EMAIL_BODY,
      },
      photos: [],
      maxPhotos: 5,
    });

    const saved = await owner.put('/api/storm/settings').send({
      thresholdIn: 1.5,
      adBudgetCents: 30000,
      adDays: 5,
      adGoogleSharePct: 40,
      emailEnabled: false,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      thresholdIn: 1.5,
      adBudgetCents: 30000,
      adDays: 5,
      adGoogleSharePct: 40,
      emailEnabled: false,
    });

    const again = await owner.get('/api/storm/settings');
    expect(again.body).toMatchObject({
      thresholdIn: 1.5,
      adBudgetCents: 30000,
      adDays: 5,
      adGoogleSharePct: 40,
      emailEnabled: false,
    });
    // The other company's settings are untouched.
    const other = await loginAs(t.app, t.seed.b.owner);
    expect((await other.get('/api/storm/settings')).body.thresholdIn).toBe(1);
  });

  test('storm settings: a template saved as its default or empty resets to the default', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    await owner.put('/api/storm/settings').send({ smsTemplate: CUSTOM_SMS, emailTemplate: CUSTOM_EMAIL, emailSubject: 'Our hail note' }).expect(200);
    expect(await storedSettings(t.seed.a.companyId)).toMatchObject({
      storm_sms_template: CUSTOM_SMS,
      storm_email_template: CUSTOM_EMAIL,
      storm_email_subject: 'Our hail note',
    });

    // The default text itself is stored as NULL, so a later change to the default still applies.
    const asDefault = await owner.put('/api/storm/settings').send({ smsTemplate: DEFAULT_STORM_SMS });
    expect(asDefault.status).toBe(200);
    expect(asDefault.body.smsTemplate).toBe(DEFAULT_STORM_SMS);
    expect((await storedSettings(t.seed.a.companyId)).storm_sms_template).toBeNull();

    // Whitespace-only and empty clear the others.
    await owner.put('/api/storm/settings').send({ emailSubject: '   ', emailTemplate: '' }).expect(200);
    const cleared = await owner.get('/api/storm/settings');
    expect(cleared.body).toMatchObject({
      emailSubject: DEFAULT_STORM_EMAIL_SUBJECT,
      emailTemplate: DEFAULT_STORM_EMAIL_BODY,
      smsTemplate: DEFAULT_STORM_SMS,
    });
    expect(await storedSettings(t.seed.a.companyId)).toMatchObject({
      storm_email_subject: null,
      storm_email_template: null,
    });
  });

  test('storm settings: validation errors name the field', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const cases: [Record<string, unknown>, string, string?][] = [
      [{ thresholdIn: 0.5 }, 'thresholdIn', HAIL],
      [{ thresholdIn: 2.25 }, 'thresholdIn', HAIL],
      [{ thresholdIn: 1.1 }, 'thresholdIn', HAIL],
      [{ adBudgetCents: 500 }, 'adBudgetCents', BUDGET],
      [{ adDays: 0 }, 'adDays', DAYS],
      [{ adDays: 31 }, 'adDays', DAYS],
      [{ adGoogleSharePct: 101 }, 'adGoogleSharePct', SHARE],
      [{ smsTemplate: 'Hi {company}. Reply yes to book.' }, 'smsTemplate', 'This text must keep Reply STOP.'],
      [{ emailTemplate: 'Hail hit {street}. {company}, {company_address}.' }, 'emailTemplate', 'This text must keep {unsubscribe}.'],
      [{ emailEnabled: 'yes' }, 'emailEnabled', 'Please choose yes or no.'],
      [{ smsTemplate: 'x'.repeat(601) }, 'smsTemplate', 'That is too long.'],
      [{ bogus: 1 }, 'bogus'],
    ];
    for (const [body, field, message] of cases) {
      const res = await owner.put('/api/storm/settings').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.field, JSON.stringify(body)).toBe(field);
      if (message !== undefined) expect(res.body.error).toBe(message);
    }
    // Nothing was saved by any of them.
    expect((await owner.get('/api/storm/settings')).body).toMatchObject({ thresholdIn: 1, adBudgetCents: 27000, adDays: 7 });
    // The edges of each range are accepted.
    await owner.put('/api/storm/settings').send({ thresholdIn: 0.75, adBudgetCents: 1000, adDays: 30, adGoogleSharePct: 0 }).expect(200);
    await owner.put('/api/storm/settings').send({ thresholdIn: 2, adBudgetCents: 1000000, adDays: 1, adGoogleSharePct: 100 }).expect(200);
  });

  test('storm settings: a rep gets 403, office may read and write', async () => {
    const rep = await loginAs(t.app, t.seed.a.rep);
    const get = await rep.get('/api/storm/settings');
    expect(get.status).toBe(403);
    expect(get.body.error).toBe(NOT_ALLOWED);
    expect((await rep.put('/api/storm/settings').send({ thresholdIn: 1.5 })).status).toBe(403);
    expect((await upload(rep, JPEG)).status).toBe(403);
    expect((await rep.delete(`/api/storm/photos/${randomUUID()}`)).status).toBe(403);
    expect((await rep.get(`/api/storm/photos/${randomUUID()}/file`)).status).toBe(403);

    const office = await loginAs(t.app, t.seed.a.office);
    expect((await office.get('/api/storm/settings')).status).toBe(200);
    const saved = await office.put('/api/storm/settings').send({ thresholdIn: 1.5 });
    expect(saved.status).toBe(200);
    expect(saved.body.thresholdIn).toBe(1.5);
  });

  test('storm photos: upload, list, fetch the file and delete', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const created = await upload(owner, JPEG);
    expect(created.status).toBe(201);
    const { id, url, createdAt } = created.body as { id: string; url: string; createdAt: string };
    expect(url).toBe(`/api/storm/photos/${id}/file`);
    expect(typeof createdAt).toBe('string');

    const listed = await owner.get('/api/storm/settings');
    expect(listed.body.photos).toEqual([{ id, url, createdAt }]);

    const file = await owner.get(url).buffer(true).parse(binary);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toMatch(/^image\/jpeg/);
    expect(file.headers['cache-control']).toBe('private, max-age=3600');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(file.body as Buffer, JPEG)).toBe(0);

    const removed = await owner.delete(`/api/storm/photos/${id}`);
    expect(removed.status).toBe(204);
    expect(removed.text ?? '').toBe('');
    expect((await owner.get('/api/storm/settings')).body.photos).toEqual([]);
    expect((await owner.get(url)).status).toBe(404);
  });

  test('storm photos: PNG accepted, GIF/other type refused, wrong magic bytes refused, empty refused', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);

    const png = await upload(owner, PNG, 'image/png');
    expect(png.status).toBe(201);
    const pngFile = await owner.get(png.body.url as string).buffer(true).parse(binary);
    expect(pngFile.headers['content-type']).toMatch(/^image\/png/);

    const gif = await upload(owner, Buffer.from('GIF89a-not-allowed'), 'image/gif');
    expect(gif.status).toBe(400);
    expect(gif.body).toEqual({ error: PHOTO_TYPE, field: 'photo' });

    const text = await upload(owner, Buffer.from('hello'), 'text/plain');
    expect(text.body).toEqual({ error: PHOTO_TYPE, field: 'photo' });

    // Claims to be a JPEG, but the bytes are not one.
    const fake = await upload(owner, Buffer.from('definitely not a jpeg'), 'image/jpeg');
    expect(fake.status).toBe(400);
    expect(fake.body).toEqual({ error: PHOTO_TYPE, field: 'photo' });

    // A PNG's bytes sent as a JPEG are refused too.
    const crossed = await upload(owner, PNG, 'image/jpeg');
    expect(crossed.body).toEqual({ error: PHOTO_TYPE, field: 'photo' });

    const empty = await upload(owner, Buffer.alloc(0), 'image/jpeg');
    expect(empty.status).toBe(400);
    expect(empty.body).toEqual({ error: PHOTO_EMPTY, field: 'photo' });

    // Only the PNG was kept.
    expect((await owner.get('/api/storm/settings')).body.photos).toHaveLength(1);
  });

  test('storm photos: more than 5 refused with field photo', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    for (let i = 0; i < 5; i++) {
      expect((await upload(owner, JPEG)).status).toBe(201);
    }
    const sixth = await upload(owner, JPEG);
    expect(sixth.status).toBe(400);
    expect(sixth.body).toEqual({ error: PHOTO_FULL, field: 'photo' });
    expect((await owner.get('/api/storm/settings')).body.photos).toHaveLength(5);
  });

  test('storm photos: over 5 MB answers 413', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5 * 1024 * 1024)]);
    const res = await upload(owner, big);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: PHOTO_TOO_BIG });
    expect((await owner.get('/api/storm/settings')).body.photos).toEqual([]);
  });

  test('storm photos: another company cannot read or delete a photo', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const { id, url } = (await upload(owner, JPEG)).body as { id: string; url: string };

    const other = await loginAs(t.app, t.seed.b.owner);
    const read = await other.get(url);
    expect(read.status).toBe(404);
    expect(read.body).toEqual({ error: NOT_FOUND });
    const gone = await other.delete(`/api/storm/photos/${id}`);
    expect(gone.status).toBe(404);
    expect(gone.body).toEqual({ error: NOT_FOUND });
    expect((await other.get('/api/storm/settings')).body.photos).toEqual([]);

    // A malformed id is the same 404, and the owner's photo is still there.
    expect((await owner.delete('/api/storm/photos/not-an-id')).status).toBe(404);
    expect((await owner.get('/api/storm/settings')).body.photos).toHaveLength(1);
    expect((await owner.get(url)).status).toBe(200);
  });
});
