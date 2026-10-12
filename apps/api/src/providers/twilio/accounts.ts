import type { Config } from '../../config.ts';
import { RegistrarUnavailableError, type SubaccountRef, type TextingAccounts } from '../registrar.ts';
import { TWILIO_API, TWILIO_MESSAGING, TwilioApiError, TwilioHttp, TwilioUnreachableError } from './http.ts';

type Capability = 'sms' | 'voice';
type Form = Record<string, string>;

/**
 * Twilio subaccounts, messaging services and local numbers for each company. Subaccount calls use the
 * master credentials; everything after that is made as the company's own subaccount.
 */
export class TwilioAccounts implements TextingAccounts {
  private readonly http: TwilioHttp;

  constructor(o: { http: TwilioHttp }) {
    this.http = o.http;
  }

  async ensureSubaccount(companyId: string): Promise<{ accountSid: string; authToken: string }> {
    return mapSetupErrors(async () => {
      const friendlyName = `roofline:${companyId}`;
      const list = await this.http.request<{ accounts: Array<{ sid: string; auth_token: string }> }>(
        'GET',
        `${TWILIO_API}/Accounts.json`,
        { FriendlyName: friendlyName, Status: 'active' },
      );
      const [existing] = list.accounts;
      if (existing) return { accountSid: existing.sid, authToken: existing.auth_token };

      const created = await this.http.request<{ sid: string; auth_token: string }>(
        'POST',
        `${TWILIO_API}/Accounts.json`,
        { FriendlyName: friendlyName },
      );
      return { accountSid: created.sid, authToken: created.auth_token };
    });
  }

  async ensureMessagingService(
    sub: SubaccountRef,
    companyId: string,
    urls: { inbound: string; status: string },
  ): Promise<{ messagingServiceSid: string }> {
    return mapSetupErrors(async () => {
      const http = this.http.as(sub);
      const name = `Roofline ${companyId}`;
      const list = await http.request<{ services: Array<{ sid: string; friendly_name: string }> }>(
        'GET',
        `${TWILIO_MESSAGING}/Services`,
        { PageSize: '50' },
      );
      const found = list.services.find((service) => service.friendly_name === name);
      if (found) {
        // Keep the webhook URLs current on a service we already own.
        await http.request<unknown>('POST', `${TWILIO_MESSAGING}/Services/${found.sid}`, {
          InboundRequestUrl: urls.inbound,
          StatusCallback: urls.status,
        });
        return { messagingServiceSid: found.sid };
      }

      const created = await http.request<{ sid: string }>('POST', `${TWILIO_MESSAGING}/Services`, {
        FriendlyName: name,
        InboundRequestUrl: urls.inbound,
        InboundMethod: 'POST',
        StatusCallback: urls.status,
        UseInboundWebhookOnNumber: 'false',
      });
      return { messagingServiceSid: created.sid };
    });
  }

  async ensureNumber(
    sub: SubaccountRef,
    i: { messagingServiceSid: string; areaCode: string | null; state: string | null },
  ): Promise<{ e164: string; phoneNumberSid: string; capabilities: Capability[] }> {
    return mapSetupErrors(async () => {
      const http = this.http.as(sub);
      const mg = i.messagingServiceSid;

      const attached = await http.request<{
        phone_numbers: Array<{ sid: string; phone_number: string; capabilities: unknown }>;
      }>('GET', `${TWILIO_MESSAGING}/Services/${mg}/PhoneNumbers`);
      const [current] = attached.phone_numbers;
      if (current) {
        return {
          e164: current.phone_number,
          phoneNumberSid: current.sid,
          capabilities: normalizeCapabilities(current.capabilities),
        };
      }

      const chosen = await findAvailableNumber(http, sub.accountSid, i);

      const purchased = await http.request<{ sid: string; phone_number: string; capabilities: unknown }>(
        'POST',
        `${TWILIO_API}/Accounts/${sub.accountSid}/IncomingPhoneNumbers.json`,
        { PhoneNumber: chosen },
      );
      await http.request<unknown>('POST', `${TWILIO_MESSAGING}/Services/${mg}/PhoneNumbers`, {
        PhoneNumberSid: purchased.sid,
      });
      return {
        e164: purchased.phone_number,
        phoneNumberSid: purchased.sid,
        capabilities: normalizeCapabilities(purchased.capabilities),
      };
    });
  }
}

/**
 * The adapter when both Twilio master credentials are set, else null (the caller then uses the
 * unconfigured half).
 */
export function twilioAccountsFor(config: Config): TextingAccounts | null {
  if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN) return null;
  return new TwilioAccounts({
    http: new TwilioHttp({ accountSid: config.TWILIO_ACCOUNT_SID, authToken: config.TWILIO_AUTH_TOKEN }),
  });
}

/**
 * The first available US local number, trying the area code, then the state, then anywhere. Returns the
 * phone number in E.164 form.
 */
async function findAvailableNumber(
  http: TwilioHttp,
  accountSid: string,
  i: { areaCode: string | null; state: string | null },
): Promise<string> {
  const filters: Form[] = [];
  if (i.areaCode !== null) filters.push({ AreaCode: i.areaCode });
  if (i.state !== null) filters.push({ InRegion: i.state });
  filters.push({});

  for (const filter of filters) {
    const search = await http.request<{ available_phone_numbers: Array<{ phone_number: string }> }>(
      'GET',
      `${TWILIO_API}/Accounts/${accountSid}/AvailablePhoneNumbers/US/Local.json`,
      { SmsEnabled: 'true', VoiceEnabled: 'true', PageSize: '1', ...filter },
    );
    const [choice] = search.available_phone_numbers;
    if (choice) return choice.phone_number;
  }
  throw new RegistrarUnavailableError('No numbers were available.');
}

/**
 * Twilio capabilities as the adapter reports them: an array of names (`['MMS','SMS','Voice']`) or an
 * object of booleans (`{ voice: true, SMS: true }`). Returns the sms and voice flags in that order.
 */
function normalizeCapabilities(input: unknown): Capability[] {
  const names = new Set<string>();
  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') names.add(item.toLowerCase());
    }
  } else if (input !== null && typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) {
      if (value === true) names.add(key.toLowerCase());
    }
  } else {
    return [];
  }
  return (['sms', 'voice'] as const).filter((capability) => names.has(capability));
}

/**
 * Maps a Twilio failure to the registrar's error. Twilio's own text is never kept: a refusal keeps only its
 * numeric code. Errors that are already registrar errors, or anything else, pass through.
 */
async function mapSetupErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RegistrarUnavailableError) throw error;
    if (error instanceof TwilioUnreachableError) throw new RegistrarUnavailableError("Twilio didn't answer.");
    if (error instanceof TwilioApiError) {
      throw new RegistrarUnavailableError(`Twilio refused a setup request (code ${error.code ?? 'none'}).`);
    }
    throw error;
  }
}
