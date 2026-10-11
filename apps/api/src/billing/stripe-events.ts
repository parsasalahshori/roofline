import { type CompanyStatus, planFromLookupKey } from '@roofline/shared';

export type BillingUpdate = {
  customerId: string;
  eventId: string;
  eventCreated: Date;
  set: {
    status?: CompanyStatus;
    stripeSubscriptionId?: string;
    planKey?: string;
    billingPeriodStart?: Date;
  };
  onlyIfPastDue?: boolean;
};

type StripeEventLike = {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
};

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function companyStatusFor(subscriptionStatus: string): CompanyStatus | null {
  switch (subscriptionStatus) {
    case 'trialing':
    case 'active':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    default:
      return null;
  }
}

function planKeyFor(object: Obj): string | undefined {
  const metadata = isObj(object.metadata) ? object.metadata : undefined;
  const fromMetadata = str(metadata?.plan_key);
  if (fromMetadata !== undefined && fromMetadata !== '') return fromMetadata;

  const items = isObj(object.items) && Array.isArray(object.items.data) ? object.items.data : [];
  for (const item of items) {
    if (!isObj(item) || !isObj(item.price)) continue;
    const lookupKey = str(item.price.lookup_key);
    if (lookupKey === undefined) continue;
    const plan = planFromLookupKey(lookupKey);
    if (plan !== null) return plan;
  }
  return undefined;
}

function billingPeriodStartFor(object: Obj): Date | undefined {
  const items = isObj(object.items) && Array.isArray(object.items.data) ? object.items.data : [];
  const first = items[0];
  const itemStart = isObj(first) ? num(first.current_period_start) : undefined;
  const secs = itemStart ?? num(object.current_period_start);
  return secs === undefined ? undefined : new Date(secs * 1000);
}

function subscriptionUpdate(object: Obj): BillingUpdate['set'] {
  const set: BillingUpdate['set'] = {};
  const status = str(object.status);
  const mapped = status === undefined ? null : companyStatusFor(status);
  if (mapped !== null) set.status = mapped;

  const subscriptionId = str(object.id);
  if (subscriptionId !== undefined) set.stripeSubscriptionId = subscriptionId;

  const planKey = planKeyFor(object);
  if (planKey !== undefined) set.planKey = planKey;

  const periodStart = billingPeriodStartFor(object);
  if (periodStart !== undefined) set.billingPeriodStart = periodStart;
  return set;
}

export function billingUpdateFor(event: StripeEventLike): BillingUpdate | null {
  const object = event.data.object;
  const customerId = str(object.customer);
  if (customerId === undefined) return null;

  const base = {
    customerId,
    eventId: event.id,
    eventCreated: new Date(event.created * 1000),
  };

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      return { ...base, set: subscriptionUpdate(object) };
    case 'customer.subscription.deleted':
      return { ...base, set: { status: 'canceled' } };
    case 'invoice.payment_failed':
      return { ...base, set: { status: 'past_due' } };
    case 'invoice.paid':
      return { ...base, set: { status: 'active' }, onlyIfPastDue: true };
    default:
      return null;
  }
}
