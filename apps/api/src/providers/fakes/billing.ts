import {
  BillingRefusedError,
  BillingUnavailableError,
  type BillingProvider,
} from '../billing.ts';

type Input<K extends Exclude<keyof BillingProvider, 'configured'>> = Parameters<BillingProvider[K]>[0];

/** Deterministic billing provider: no network. Ids count up from 1 in call order. */
export class FakeBillingProvider implements BillingProvider {
  readonly configured = true;
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly checkouts: Input<'createCheckout'>[] = [];
  readonly portals: Input<'createPortal'>[] = [];
  readonly planChanges: Input<'changePlan'>[] = [];
  readonly meterEvents: Input<'reportMeterEvent'>[] = [];
  readonly invoiceItems: (Input<'createInvoiceItem'> & { invoiceItemId: string })[] = [];
  private failures = 0;
  private failKind: 'unavailable' | 'refused' = 'unavailable';
  private customerByCompany = new Map<string, string>();
  private customerSeq = 0;
  private checkoutSeq = 0;
  private portalSeq = 0;
  private invoiceSeq = 0;
  private meterIds = new Set<string>();
  private invoiceByKey = new Map<string, string>();

  /** Makes the next `n` calls throw BillingUnavailableError. */
  failNext(n = 1, kind: 'unavailable' | 'refused' = 'unavailable'): void {
    this.failKind = kind;
    this.failures += n;
  }

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
    if (this.failures > 0) {
      this.failures--;
      if (this.failKind === 'refused') throw new BillingRefusedError('Fake billing refused.');
      throw new BillingUnavailableError('Fake billing is unavailable.');
    }
  }

  async ensureCustomer(i: Input<'ensureCustomer'>): Promise<{ customerId: string }> {
    this.record('ensureCustomer', [i]);
    if (i.existingCustomerId) return { customerId: i.existingCustomerId };
    const known = this.customerByCompany.get(i.companyId);
    if (known) return { customerId: known };
    this.customerSeq++;
    const customerId = `cus_fake_${this.customerSeq}`;
    this.customerByCompany.set(i.companyId, customerId);
    return { customerId };
  }

  async createCheckout(i: Input<'createCheckout'>): Promise<{ url: string }> {
    this.record('createCheckout', [i]);
    this.checkoutSeq++;
    this.checkouts.push(i);
    return { url: `https://checkout.stripe.test/c/cs_fake_${this.checkoutSeq}` };
  }

  async createPortal(i: Input<'createPortal'>): Promise<{ url: string }> {
    this.record('createPortal', [i]);
    this.portalSeq++;
    this.portals.push(i);
    return { url: `https://billing.stripe.test/p/bps_fake_${this.portalSeq}` };
  }

  async changePlan(i: Input<'changePlan'>): Promise<void> {
    this.record('changePlan', [i]);
    this.planChanges.push(i);
  }

  async reportMeterEvent(i: Input<'reportMeterEvent'>): Promise<void> {
    this.record('reportMeterEvent', [i]);
    if (this.meterIds.has(i.identifier)) return;
    this.meterIds.add(i.identifier);
    this.meterEvents.push(i);
  }

  async createInvoiceItem(i: Input<'createInvoiceItem'>): Promise<{ invoiceItemId: string }> {
    this.record('createInvoiceItem', [i]);
    const known = this.invoiceByKey.get(i.idempotencyKey);
    if (known) return { invoiceItemId: known };
    this.invoiceSeq++;
    const invoiceItemId = `ii_fake_${this.invoiceSeq}`;
    this.invoiceByKey.set(i.idempotencyKey, invoiceItemId);
    this.invoiceItems.push({ ...i, invoiceItemId });
    return { invoiceItemId };
  }
}
