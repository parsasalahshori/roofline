import type { BrandInfo, CampaignInfo } from '@roofline/shared';
import type { Config } from '../config.ts';
import { FakeTextingRegistrar } from './fakes/registrar.ts';
import { twilioAccountsFor } from './twilio/accounts.ts';
import { twilioBrandsFor } from './twilio/brands.ts';

export type SubaccountRef = { accountSid: string; authToken: string };
export type ReviewStatus = 'pending' | 'approved' | 'failed';
export interface TextingAccounts {
  ensureSubaccount(companyId: string): Promise<{ accountSid: string; authToken: string }>;
  ensureMessagingService(sub: SubaccountRef, companyId: string, urls: { inbound: string; status: string }): Promise<{ messagingServiceSid: string }>;
  ensureNumber(sub: SubaccountRef, i: { messagingServiceSid: string; areaCode: string | null; state: string | null }):
    Promise<{ e164: string; phoneNumberSid: string; capabilities: ('sms' | 'voice')[] }> }
export interface TextingBrands {
  submitBrand(sub: SubaccountRef, i: { companyId: string; brand: BrandInfo; statusCallback: string;
    previous: { customerProfileSid: string | null; trustProductSid: string | null; brandSid: string | null } }):
    Promise<{ customerProfileSid: string; trustProductSid: string; brandSid: string }>;
  brandStatus(sub: SubaccountRef, brandSid: string): Promise<{ status: ReviewStatus; failureReason: string | null }>;
  submitCampaign(sub: SubaccountRef, i: { brandSid: string; messagingServiceSid: string; campaign: CampaignInfo; previousCampaignSid: string | null }):
    Promise<{ campaignSid: string }>;
  campaignStatus(sub: SubaccountRef, messagingServiceSid: string, campaignSid: string): Promise<{ status: ReviewStatus; failureReason: string | null }> }
export type TextingRegistrar = TextingAccounts & TextingBrands & { readonly configured: boolean };
export class RegistrarUnavailableError extends Error {}
export class RegistrarRejectedError extends Error { constructor(readonly reasonText: string) { super(reasonText); } }

const SETUP_MESSAGE = "Texting registration isn't set up.";

/** Account half used when no real texting registrar is configured. */
const unconfiguredAccounts: TextingAccounts = {
  async ensureSubaccount() { throw new RegistrarUnavailableError(SETUP_MESSAGE); },
  async ensureMessagingService() { throw new RegistrarUnavailableError(SETUP_MESSAGE); },
  async ensureNumber() { throw new RegistrarUnavailableError(SETUP_MESSAGE); },
};

/** Brand and campaign half used when no real texting registrar is configured. */
const unconfiguredBrands: TextingBrands = {
  async submitBrand() { throw new RegistrarUnavailableError(SETUP_MESSAGE); },
  async brandStatus() { throw new RegistrarUnavailableError(SETUP_MESSAGE); },
  async submitCampaign() { throw new RegistrarUnavailableError(SETUP_MESSAGE); },
  async campaignStatus() { throw new RegistrarUnavailableError(SETUP_MESSAGE); },
};

/**
 * The texting registrar the app uses. Under FAKE_PROVIDERS it is the fake. Otherwise each half comes from
 * its Twilio adapter when configured, else from the unconfigured half. Methods are bound, not spread, so
 * class instances keep their `this`. `configured` is true when the accounts half is real.
 */
export function createRegistrar(config: Config): TextingRegistrar {
  if (config.FAKE_PROVIDERS) return new FakeTextingRegistrar();
  const accountsReal = twilioAccountsFor(config);
  const accounts = accountsReal ?? unconfiguredAccounts;
  const brands = twilioBrandsFor(config) ?? unconfiguredBrands;
  return {
    configured: accountsReal !== null,
    ensureSubaccount: accounts.ensureSubaccount.bind(accounts),
    ensureMessagingService: accounts.ensureMessagingService.bind(accounts),
    ensureNumber: accounts.ensureNumber.bind(accounts),
    submitBrand: brands.submitBrand.bind(brands),
    brandStatus: brands.brandStatus.bind(brands),
    submitCampaign: brands.submitCampaign.bind(brands),
    campaignStatus: brands.campaignStatus.bind(brands),
  };
}
