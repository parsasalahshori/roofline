import type { BrandInfo, CampaignInfo } from '@roofline/shared';
import type { Config } from '../../config.ts';
import {
  type BrandProgress,
  RegistrarRejectedError,
  RegistrarUnavailableError,
  type ReviewStatus,
  type SubaccountRef,
  type TextingBrands,
} from '../registrar.ts';
import { submitBrandFlow, type BrandPrevious } from './brand-profile.ts';
import { TWILIO_MESSAGING, TwilioApiError, TwilioHttp, TwilioUnreachableError } from './http.ts';

export { SECONDARY_PROFILE_POLICY, A2P_PROFILE_POLICY } from './brand-profile.ts';

type BrandStatusBody = { status?: unknown; failure_reason?: unknown };
type CampaignStatusBody = { campaign_status?: unknown; errors?: Array<{ description?: unknown }> };
type CampaignCreated = { sid: string };

/**
 * The A2P brand and mixed-use campaign for each company, made as the company's own subaccount. Business
 * profile, messaging profile and brand: brand-profile.ts. Campaign and status reads: this file.
 */
export class TwilioBrands implements TextingBrands {
  private readonly http: TwilioHttp;
  private readonly primaryProfileSid: string;

  constructor(o: { http: TwilioHttp; primaryProfileSid: string }) {
    this.http = o.http;
    this.primaryProfileSid = o.primaryProfileSid;
  }

  async submitBrand(
    sub: SubaccountRef,
    i: {
      companyId: string;
      brand: BrandInfo;
      statusCallback: string;
      previous: BrandPrevious;
      onProgress?: (p: BrandProgress) => void;
    },
  ): Promise<{ customerProfileSid: string; trustProductSid: string; brandSid: string }> {
    return mapErrors(() =>
      submitBrandFlow(this.http.as(sub), {
        sub,
        primaryProfileSid: this.primaryProfileSid,
        companyId: i.companyId,
        brand: i.brand,
        statusCallback: i.statusCallback,
        previous: i.previous,
        ...(i.onProgress ? { onProgress: i.onProgress } : {}),
      }),
    );
  }

  async brandStatus(sub: SubaccountRef, brandSid: string): Promise<{ status: ReviewStatus; failureReason: string | null }> {
    return mapErrors(async () => {
      const body = await this.http
        .as(sub)
        .request<BrandStatusBody>('GET', `${TWILIO_MESSAGING}/a2p/BrandRegistrations/${brandSid}`);
      if (body.status === 'APPROVED') return { status: 'approved', failureReason: null };
      if (body.status === 'FAILED') {
        const reason = typeof body.failure_reason === 'string' ? body.failure_reason : null;
        return { status: 'failed', failureReason: reason };
      }
      return { status: 'pending', failureReason: null };
    });
  }

  async submitCampaign(
    sub: SubaccountRef,
    i: { brandSid: string; messagingServiceSid: string; campaign: CampaignInfo; previousCampaignSid: string | null },
  ): Promise<{ campaignSid: string }> {
    return mapErrors(async () => {
      const http = this.http.as(sub);
      const base = `${TWILIO_MESSAGING}/Services/${i.messagingServiceSid}/Compliance/Usa2p`;
      const { campaign } = i;

      if (i.previousCampaignSid !== null) {
        await http.request<undefined>('DELETE', `${base}/${i.previousCampaignSid}`);
      }
      const created = await http.request<CampaignCreated>('POST', base, {
        BrandRegistrationSid: i.brandSid,
        Description: campaign.description,
        MessageFlow: campaign.messageFlow,
        MessageSamples: campaign.samples,
        UsAppToPersonUsecase: 'MIXED',
        HasEmbeddedLinks: 'true',
        HasEmbeddedPhone: 'true',
        OptInMessage: campaign.optInMessage,
        OptOutMessage: campaign.optOutMessage,
        HelpMessage: campaign.helpMessage,
        OptInKeywords: 'START',
        OptOutKeywords: 'STOP',
        HelpKeywords: 'HELP',
      });
      return { campaignSid: created.sid };
    });
  }

  async campaignStatus(
    sub: SubaccountRef,
    messagingServiceSid: string,
    campaignSid: string,
  ): Promise<{ status: ReviewStatus; failureReason: string | null }> {
    return mapErrors(async () => {
      const body = await this.http
        .as(sub)
        .request<CampaignStatusBody>('GET', `${TWILIO_MESSAGING}/Services/${messagingServiceSid}/Compliance/Usa2p/${campaignSid}`);
      if (body.campaign_status === 'VERIFIED') return { status: 'approved', failureReason: null };
      if (body.campaign_status === 'FAILED' || body.campaign_status === 'EXPIRED') {
        const description = body.errors?.[0]?.description;
        return { status: 'failed', failureReason: typeof description === 'string' ? description : null };
      }
      return { status: 'pending', failureReason: null };
    });
  }
}

/**
 * The adapter when the Twilio master credentials and the primary profile sid are all set, else null (the
 * caller then uses the unconfigured half).
 */
export function twilioBrandsFor(config: Config): TextingBrands | null {
  if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN || !config.TWILIO_PRIMARY_PROFILE_SID) return null;
  return new TwilioBrands({
    http: new TwilioHttp({ accountSid: config.TWILIO_ACCOUNT_SID, authToken: config.TWILIO_AUTH_TOKEN }),
    primaryProfileSid: config.TWILIO_PRIMARY_PROFILE_SID,
  });
}

/**
 * Maps a Twilio failure to the registrar's error. Twilio's text is never kept: a refusal keeps only its
 * numeric code. Registrar errors and anything else pass through unchanged.
 */
async function mapErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RegistrarRejectedError || error instanceof RegistrarUnavailableError) throw error;
    if (error instanceof TwilioUnreachableError) throw new RegistrarUnavailableError("Twilio didn't answer.");
    if (error instanceof TwilioApiError && (error.status === 429 || error.status === 401 || error.status === 403)) {
      throw new RegistrarUnavailableError(`Twilio refused a request (code ${error.code ?? 'none'}).`);
    }
    if (error instanceof TwilioApiError) throw new RegistrarRejectedError(`Twilio error ${error.code ?? 'none'}`);
    throw error;
  }
}
