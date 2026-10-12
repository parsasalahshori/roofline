import { describe, expect, it } from 'vitest';
import {
  COMING_WITH,
  deriveSetup,
  SETUP_ITEM_KEYS,
  type SetupFacts,
  type SetupItemKey,
  type SetupItemView,
  type SetupView,
} from '../src/setup.ts';

function facts(o: Partial<SetupFacts> = {}): SetupFacts {
  return {
    addressSaved: false,
    located: false,
    serviceArea: false,
    imports: { done: 0, running: 0 },
    texting: { campaignStatus: 'none', rejectionReason: null, rejectedFields: [] },
    activeMembers: 0,
    pendingInvites: 0,
    paymentMethod: false,
    ads: { active: 0, pending: 0 },
    calendarsConnected: 0,
    pricesAndTiersSaved: false,
    forwardingVerified: false,
    skipped: new Set<SetupItemKey>(),
    ...o,
  };
}

function item(view: SetupView, key: SetupItemKey): SetupItemView {
  const found = view.items.find((i) => i.key === key);
  if (!found) throw new Error(`no item ${key}`);
  return found;
}

describe('deriveSetup', () => {
  it('a brand-new company has everything to do', () => {
    const view = deriveSetup(facts());
    expect(view.items.map((i) => i.key)).toEqual(SETUP_ITEM_KEYS);
    expect(view.items).toHaveLength(9);

    const foundation: SetupItemKey[] = [
      'company_basics',
      'import_customers',
      'texting_registration',
      'invite_team',
      'payment_method',
    ];
    for (const key of foundation) {
      expect(item(view, key).status).toBe('todo');
      expect(item(view, key).comingWith).toBeNull();
    }

    const later: [SetupItemKey, string][] = [
      ['connect_ads', 'storm_scout'],
    ];
    for (const [key, comingWith] of later) {
      expect(item(view, key).status).toBe('todo');
      expect(item(view, key).comingWith).toBe(comingWith);
    }

    expect(item(view, 'connect_calendar').status).toBe('todo');
    expect(item(view, 'connect_calendar').comingWith).toBeNull();
    expect(item(view, 'phone_number').status).toBe('todo');
    expect(item(view, 'phone_number').comingWith).toBeNull();

    expect(view.progress).toEqual({ done: 0, total: 5 });
  });

  it('a located company with a card and a teammate', () => {
    const view = deriveSetup(
      facts({
        addressSaved: true,
        located: true,
        serviceArea: true,
        paymentMethod: true,
        activeMembers: 2,
      }),
    );
    expect(item(view, 'company_basics').status).toBe('done');
    expect(item(view, 'invite_team').status).toBe('done');
    expect(item(view, 'payment_method').status).toBe('done');
    expect(view.progress).toEqual({ done: 3, total: 5 });
    expect(item(view, 'company_basics').data).toEqual({ located: true, serviceArea: true });
  });

  it('waiting on carriers, and a rejection with its reason', () => {
    const pending = deriveSetup(facts({ texting: { campaignStatus: 'pending', rejectionReason: null, rejectedFields: [] } }));
    expect(item(pending, 'texting_registration').status).toBe('waiting');

    const rejected = deriveSetup(
      facts({ texting: { campaignStatus: 'rejected', rejectionReason: 'R', rejectedFields: ['ein'] } }),
    );
    expect(item(rejected, 'texting_registration')).toMatchObject({
      status: 'todo',
      data: { rejected: true, reason: 'R', fields: ['ein'] },
    });
  });

  it('skips only what may be skipped, and done beats skipped', () => {
    const doneBeatsSkip = deriveSetup(facts({ skipped: new Set(['import_customers']), imports: { done: 1, running: 0 } }));
    expect(item(doneBeatsSkip, 'import_customers').status).toBe('done');

    const skippedImport = deriveSetup(facts({ skipped: new Set(['import_customers']) }));
    expect(item(skippedImport, 'import_customers').status).toBe('skipped');
    expect(skippedImport.progress.done).toBe(1);

    const notSkippable = deriveSetup(facts({ skipped: new Set(['payment_method']) }));
    expect(item(notSkippable, 'payment_method').status).toBe('todo');

    const view = deriveSetup(facts());
    const skippable = view.items.filter((i) => i.skippable).map((i) => i.key);
    expect(skippable).toEqual(['import_customers', 'invite_team']);
  });

  it('phone number is done once forwarding is verified, and never skippable', () => {
    const unverified = deriveSetup(facts());
    expect(item(unverified, 'phone_number')).toMatchObject({ status: 'todo', comingWith: null, skippable: false });

    const verified = deriveSetup(facts({ forwardingVerified: true }));
    expect(item(verified, 'phone_number')).toMatchObject({ status: 'done', comingWith: null, data: {} });
    expect(verified.progress.done).toBe(0);

    const skipIgnored = deriveSetup(facts({ skipped: new Set(['phone_number']) }));
    expect(item(skipIgnored, 'phone_number').status).toBe('todo');
    expect(skippableKeys(skipIgnored)).not.toContain('phone_number');
  });

  it('invites pending is started', () => {
    const invites = deriveSetup(facts({ pendingInvites: 1, activeMembers: 1 }));
    expect(item(invites, 'invite_team').status).toBe('in_progress');

    const importing = deriveSetup(facts({ imports: { done: 0, running: 1 } }));
    expect(item(importing, 'import_customers').status).toBe('in_progress');

    const addressOnly = deriveSetup(facts({ addressSaved: true, located: false }));
    expect(item(addressOnly, 'company_basics').status).toBe('in_progress');
  });

  it('connect_ads is todo by default, waiting when one is pending, done when one is active', () => {
    expect(item(deriveSetup(facts()), 'connect_ads').status).toBe('todo');
    expect(item(deriveSetup(facts({ ads: { active: 0, pending: 1 } })), 'connect_ads').status).toBe('waiting');
    expect(item(deriveSetup(facts({ ads: { active: 1, pending: 0 } })), 'connect_ads').status).toBe('done');
    expect(item(deriveSetup(facts({ ads: { active: 1, pending: 1 } })), 'connect_ads').status).toBe('done');
  });

  it('ad accounts do not change the Foundation progress', () => {
    expect(deriveSetup(facts({ ads: { active: 2, pending: 1 } })).progress).toEqual({ done: 0, total: 5 });
  });

  it('connect_calendar is done once one calendar is connected', () => {
    const one = deriveSetup(facts({ calendarsConnected: 1 }));
    expect(item(one, 'connect_calendar').status).toBe('done');
    expect(item(one, 'connect_calendar').comingWith).toBeNull();

    const three = deriveSetup(facts({ calendarsConnected: 3 }));
    expect(item(three, 'connect_calendar').status).toBe('done');
  });

  it('connect_calendar stays todo with none connected', () => {
    const view = deriveSetup(facts({ calendarsConnected: 0 }));
    expect(item(view, 'connect_calendar').status).toBe('todo');
  });

  it('a stored skip never hides connect_calendar', () => {
    const view = deriveSetup(facts({ skipped: new Set(['connect_calendar']), calendarsConnected: 0 }));
    expect(item(view, 'connect_calendar').status).toBe('todo');
    expect(item(view, 'connect_calendar').skippable).toBe(false);
  });

  it('connect_calendar does not count toward progress', () => {
    const view = deriveSetup(facts({ calendarsConnected: 2 }));
    expect(view.progress).toEqual({ done: 0, total: 5 });
  });

  it("keeps 'calendar' in COMING_WITH (Ruling CC) even though no item returns it", () => {
    expect(COMING_WITH).toContain('calendar');
  });
});

describe('prices_and_tiers', () => {
  it('prices_and_tiers is todo with comingWith null when nothing is saved', () => {
    const row = item(deriveSetup(facts()), 'prices_and_tiers');
    expect(row.status).toBe('todo');
    expect(row.comingWith).toBeNull();
    expect(row.skippable).toBe(false);
  });

  it('prices_and_tiers is done when pricesAndTiersSaved is true', () => {
    expect(item(deriveSetup(facts({ pricesAndTiersSaved: true })), 'prices_and_tiers').status).toBe('done');
  });

  it('prices_and_tiers cannot be skipped (a stored skip is ignored)', () => {
    const view = deriveSetup(facts({ skipped: new Set<SetupItemKey>(['prices_and_tiers']) }));
    expect(item(view, 'prices_and_tiers').status).toBe('todo');
  });
});

function skippableKeys(view: SetupView): SetupItemKey[] {
  return view.items.filter((i) => i.skippable).map((i) => i.key);
}
