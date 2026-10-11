import { createHash } from 'node:crypto';
import type { BrandInfo, CampaignInfo } from '@roofline/shared';
import {
  RegistrarRejectedError,
  RegistrarUnavailableError,
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
type Method = keyof TextingAccounts | keyof TextingBrands;

/** Deterministic texting registrar: no network. Statuses start pending until a test sets them. */
export class FakeTextingRegistrar implements TextingRegistrar {
  readonly configured = true;
  readonly calls: { method: string; args: unknown[] }[] = [];
  private brand: Review = { status: 'pending', failureReason: null };
  private campaign: Review = { status: 'pending', failureReason: null };
  private failures = new Map<Method, Failure[]>();

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
    i: { companyId: string; brand: BrandInfo; statusCallback: string; previous: { customerProfileSid: string | null; trustProductSid: string | null; brandSid: string | null } },
  ): ReturnType<TextingBrands['submitBrand']> {
    this.record('submitBrand', [sub, i]);
    return {
      customerProfileSid: fakeSid('BU', 'cp:' + i.companyId),
      trustProductSid: fakeSid('BU', 'tp:' + i.companyId),
      brandSid: fakeSid('BN', i.companyId),
    };
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
