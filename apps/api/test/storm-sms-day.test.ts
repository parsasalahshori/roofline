import { beforeEach, describe, expect, test } from 'vitest';
import { Actors } from './crm-helpers.ts';
import { addCompanyStorm, STORM_DAY } from './email-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { addSmsCustomers, approvedBatch, rowFor, stepMessages } from './sms-helpers.ts';

/* The {day} of a storm text is worked out when the text is sent, not when it was drafted (S1 fix 3). */

let t: TestApp;
let actors: Actors;

/** The storm's convective day is 2026-10-12. 23:50 that day in Chicago (CDT, UTC-5). */
const SAME_DAY_LATE = new Date('2026-10-13T04:50:00.000Z');
/** 00:10 the next day in Chicago. */
const NEXT_DAY_EARLY = new Date('2026-10-13T05:10:00.000Z');

beforeEach(async () => {
  t = await makeTestApp();
  actors = new Actors(t);
});

async function stormText(): Promise<string> {
  const [ann] = await addSmsCustomers(t, 'a', [
    { firstName: 'Ann', phone: '+14025550101', consent: 'attested', state: 'NE', timezone: 'America/Chicago' },
  ]);
  const stormId = await addCompanyStorm(t, 'a', STORM_DAY);
  const { stepId } = await approvedBatch(t, actors, [ann!], {
    body: 'Acme Roofing: hail hit {street} {day}. Reply STOP to opt out.',
    fields: { [ann!]: { street: 'Elm St', day: 'drafted-day' } },
    dedupePrefix: `storm:${stormId}`,
  });
  await t.queue.drain(t.deps);
  return rowFor(await stepMessages(t, 'a', stepId), ann!).body;
}

describe('storm text day label', () => {
  test('says today on the storm day, whatever the draft said', async () => {
    t.clock.set(SAME_DAY_LATE);
    expect(await stormText()).toBe('Acme Roofing: hail hit Elm St today. Reply STOP to opt out.');
  });

  test('says yesterday once the company clock is past midnight', async () => {
    t.clock.set(NEXT_DAY_EARLY);
    expect(await stormText()).toBe('Acme Roofing: hail hit Elm St yesterday. Reply STOP to opt out.');
  });
});
