import { createHash } from 'node:crypto';
import type { BrandInfo, CampaignInfo } from '@roofline/shared';
import {
  RegistrarRejectedError,
  RegistrarUnavailableError,
  type BrandProgress,
  type ReviewStatus,
  type SubaccountRef,
  type TextingAccounts,
  type TextingBrands,
  type TextingRegistrar,
} from '../registrar.ts';

/** A Twilio-shaped sid: the prefix, then the first 32 hex characters of sha256(seed). */
export function fakeSid(prefix: string, seed: string): string {
  return prefix + createHash('sha256').update(seed).digest('hex').slice(0, 32);
}

type Review = { status: ReviewStatus; failureReason: string | null };
type Failure = 'unavailable' | { rejected: string };
type BrandStep = 'customerProfile' | 'trustProduct' | 'brand';
const BRAND_STEPS: BrandStep[] = ['customerProfile', 'trustProduct', 'brand'];
type Method = keyof TextingAccounts | keyof TextingBrands;

/** Deterministic texting registrar: no network. Statuses start pending until a test sets them. */
export class FakeTextingRegistrar implements TextingRegistrar {
  readonly configured = true;
  readonly calls: { method: string; args: unknown[] }[] = [];
  private brand: Review = { status: 'pending', failureReason: null };
  private campaign: Review = { status: 'pending', failureReason: null };
  private failures = new Map<Method, Failure[]>();
  private afterStep: { step: BrandStep; what: Failure } | null = null;

  /**
   * The next submitBrand reports progress for every step up to and including `step`, then throws
   * (a failure part-way through the brand flow). Consumed once, after any failNext.
   */
  failAfter(step: BrandStep, what: Failure): void {
    this.afterStep = { step, what };
  }

  /** Makes the next call of `method` throw: RegistrarUnavailableError, or RegistrarRejectedError with `rejected` as its reasonText. */
  failNext(method: Method, what: Failure): void {
    const queue = this.failures.get(method) ?? [];
    queue.push(what);
    this.failures.set(method, queue);
  }

  setBrand(status: ReviewStatus, reason?: string): void {
    this.brand = { status, failureReason: reason ?? null };
  }

  setCampaign(status: ReviewStatus, reason?: string): void {
    this.campaign = { status, failureReason: reason ?? null };
  }

  private record(method: Method, args: unknown[]): void {
    this.calls.push({ method, args });
    const queue = this.failures.get(method);
    const what = queue?.shift();
    if (what === undefined) return;
    if (what === 'unavailable') throw new RegistrarUnavailableError('Fake texting registrar is unavailable.');
    throw new RegistrarRejectedError(what.rejected);
  }

  async ensureSubaccount(companyId: string): ReturnType<TextingAccounts['ensureSubaccount']> {
    this.record('ensureSubaccount', [companyId]);
    return { accountSid: fakeSid('AC', companyId), authToken: 'fake-token-' + companyId.slice(0, 8) };
  }

  async ensureMessagingService(
    sub: SubaccountRef,
    companyId: string,
    urls: { inbound: string; status: string },
  ): ReturnType<TextingAccounts['ensureMessagingService']> {
    this.record('ensureMessagingService', [sub, companyId, urls]);
    return { messagingServiceSid: fakeSid('MG', companyId) };
  }

  async ensureNumber(
    sub: SubaccountRef,
    i: { messagingServiceSid: string; areaCode: string | null; state: string | null },
  ): ReturnType<TextingAccounts['ensureNumber']> {
    this.record('ensureNumber', [sub, i]);
    return {
      e164: '+1' + (i.areaCode ?? '402') + '5550100',
      phoneNumberSid: fakeSid('PN', i.messagingServiceSid),
      capabilities: ['sms', 'voice'],
    };
  }

  async submitBrand(
    sub: SubaccountRef,
    i: {
      companyId: string;
      brand: BrandInfo;
      statusCallback: string;
      previous: { customerProfileSid: string | null; trustProductSid: string | null; brandSid: string | null };
      onProgress?: (p: BrandProgress) => void;
    },
  ): ReturnType<TextingBrands['submitBrand']> {
    this.record('submitBrand', [sub, i]);
    const sids = {
      customerProfileSid: i.previous.customerProfileSid ?? fakeSid('BU', 'cp:' + i.companyId),
      trustProductSid: i.previous.trustProductSid ?? fakeSid('BU', 'tp:' + i.companyId),
      brandSid: i.previous.brandSid ?? fakeSid('BN', i.companyId),
    };
    const failure = this.afterStep;
    this.afterStep = null;
    const last = failure === null ? BRAND_STEPS.length - 1 : BRAND_STEPS.indexOf(failure.step);
    BRAND_STEPS.slice(0, last + 1).forEach((step) => {
      if (step === 'customerProfile') i.onProgress?.({ customerProfileSid: sids.customerProfileSid });
      else if (step === 'trustProduct') i.onProgress?.({ trustProductSid: sids.trustProductSid });
      else i.onProgress?.({ brandSid: sids.brandSid });
    });
    if (failure !== null) {
      if (failure.what === 'unavailable') throw new RegistrarUnavailableError('Fake texting registrar is unavailable.');
      throw new RegistrarRejectedError(failure.what.rejected);
    }
    return sids;
  }

  async brandStatus(sub: SubaccountRef, brandSid: string): ReturnType<TextingBrands['brandStatus']> {
    this.record('brandStatus', [sub, brandSid]);
    return { ...this.brand };
  }

  async submitCampaign(
    sub: SubaccountRef,
    i: { brandSid: string; messagingServiceSid: string; campaign: CampaignInfo; previousCampaignSid: string | null },
  ): ReturnType<TextingBrands['submitCampaign']> {
    this.record('submitCampaign', [sub, i]);
    return { campaignSid: fakeSid('QE', i.brandSid) };
  }

  async campaignStatus(
    sub: SubaccountRef,
    messagingServiceSid: string,
    campaignSid: string,
  ): ReturnType<TextingBrands['campaignStatus']> {
    this.record('campaignStatus', [sub, messagingServiceSid, campaignSid]);
    return { ...this.campaign };
  }
}
