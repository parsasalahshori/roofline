import { describe, expect, it } from 'vitest';
import {
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
      ['prices_and_tiers', 'estimator'],
      ['connect_calendar', 'calendar'],
      ['connect_ads', 'storm_scout'],
    ];
    for (const [key, comingWith] of later) {
      expect(item(view, key).status).toBe('todo');
      expect(item(view, key).comingWith).toBe(comingWith);
    }

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
});

function skippableKeys(view: SetupView): SetupItemKey[] {
  return view.items.filter((i) => i.skippable).map((i) => i.key);
}
