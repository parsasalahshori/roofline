import type { BrandInfo } from '@roofline/shared';
import { RegistrarRejectedError } from '../registrar.ts';
import { TWILIO_API, TWILIO_MESSAGING, TWILIO_TRUSTHUB, type TwilioHttp } from './http.ts';

export const SECONDARY_PROFILE_POLICY = 'RNdfbf3fae0e1107f8aded0e7cead80bf5'; // confirm against Twilio's ISV guide in the manual smoke (T37)
export const A2P_PROFILE_POLICY = 'RNb0d4771c2c98518d916a3d4cd70a8f8b';

export type BrandPrevious = { customerProfileSid: string | null; trustProductSid: string | null; brandSid: string | null };

type Evaluation = {
  status: 'compliant' | 'noncompliant';
  results: Array<{ friendly_name: string; fields: Array<{ friendly_name: string; passed: boolean }> }>;
};
type Assignments = { results: Array<{ object_sid: string }> };
type EndUserRecord = { type: string };
type DocumentRecord = { type: string; attributes?: { address_sids?: string | string[] } };

const TH = TWILIO_TRUSTHUB;
const NO_DETAIL_REASON = 'Your business details were not accepted.';

const BUSINESS_TYPE_NAMES: Record<BrandInfo['businessType'], string> = {
  llc: 'Limited Liability Corporation',
  corporation: 'Corporation',
  partnership: 'Partnership',
  non_profit: 'Non-profit Corporation',
};

/** The business profile's attributes, keys in this order. The EIN is sent with its digits only. */
function businessAttributes(brand: BrandInfo): Record<string, string> {
  return {
    business_name: brand.legalName,
    business_identity: 'direct_customer',
    business_type: BUSINESS_TYPE_NAMES[brand.businessType],
    business_industry: 'CONSTRUCTION',
    business_registration_identifier: 'EIN',
    business_registration_number: brand.ein.replace(/\D/g, ''),
    business_regions_of_operation: 'USA_AND_CANADA',
    website_url: brand.website,
  };
}

/** The authorized representative's attributes: the person who answers for the company. */
function repAttributes(brand: BrandInfo): Record<string, string> {
  return {
    first_name: brand.contactFirstName,
    last_name: brand.contactLastName,
    email: brand.contactEmail,
    phone_number: brand.contactPhone,
    business_title: brand.contactTitle,
    job_position: 'Other',
  };
}

/** The company's business address, as Twilio's address resource takes it. */
function addressParams(brand: BrandInfo): Record<string, string> {
  return {
    CustomerName: brand.legalName,
    Street: brand.street,
    City: brand.city,
    Region: brand.state,
    PostalCode: brand.zip,
    IsoCountry: 'US',
  };
}

/** POST a create call and return the new resource's sid. */
async function createSid(http: TwilioHttp, url: string, params: Record<string, string>): Promise<string> {
  return (await http.request<{ sid: string }>('POST', url, params)).sid;
}

/** Attach an object (end user, document or primary profile) to a customer profile or trust product. */
async function assignTo(http: TwilioHttp, base: string, objectSid: string): Promise<void> {
  await http.request('POST', `${base}/EntityAssignments`, { ObjectSid: objectSid });
}

/** The first requirement Twilio found failing, by its friendly name; a plain fallback when none is named. */
function firstFailingRequirement(evaluation: Evaluation): string {
  for (const result of evaluation.results) {
    for (const field of result.fields) {
      if (field.passed === false) return field.friendly_name;
    }
  }
  return NO_DETAIL_REASON;
}

/** Evaluate a profile or trust product against its policy. A noncompliant one is a rejection; otherwise it goes to review. */
async function submitForReview(http: TwilioHttp, base: string, policySid: string): Promise<void> {
  const evaluation = await http.request<Evaluation>('POST', `${base}/Evaluations`, { PolicySid: policySid });
  if (evaluation.status === 'noncompliant') throw new RegistrarRejectedError(firstFailingRequirement(evaluation));
  await http.request('POST', base, { Status: 'pending-review' });
}

/** Steps 1-9: a new customer profile with its business, representative, address and primary profile. */
async function createCustomerProfile(
  http: TwilioHttp,
  i: { accountSid: string; primaryProfileSid: string; companyId: string; brand: BrandInfo; statusCallback: string },
): Promise<string> {
  const { brand } = i;
  const bu = await createSid(http, `${TH}/CustomerProfiles`, {
    FriendlyName: `Roofline ${i.companyId}`,
    Email: brand.contactEmail,
    PolicySid: SECONDARY_PROFILE_POLICY,
    StatusCallback: i.statusCallback,
  });
  const base = `${TH}/CustomerProfiles/${bu}`;

  const businessSid = await createSid(http, `${TH}/EndUsers`, {
    FriendlyName: brand.legalName,
    Type: 'customer_profile_business_information',
    Attributes: JSON.stringify(businessAttributes(brand)),
  });
  await assignTo(http, base, businessSid);

  const repSid = await createSid(http, `${TH}/EndUsers`, {
    FriendlyName: `${brand.contactFirstName} ${brand.contactLastName}`,
    Type: 'authorized_representative_1',
    Attributes: JSON.stringify(repAttributes(brand)),
  });
  await assignTo(http, base, repSid);

  const addressSid = await createSid(http, `${TWILIO_API}/Accounts/${i.accountSid}/Addresses.json`, addressParams(brand));
  const documentSid = await createSid(http, `${TH}/SupportingDocuments`, {
    FriendlyName: `${brand.legalName} address`,
    Type: 'customer_profile_address',
    Attributes: JSON.stringify({ address_sids: [addressSid] }),
  });
  await assignTo(http, base, documentSid);

  await assignTo(http, base, i.primaryProfileSid);
  return bu;
}

/** The address sids a supporting document lists. Twilio sends a single sid or an array. */
function addressSidsOf(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * A resubmission after a fix (Ruling AL): the existing business end user, representative and address are
 * updated in place. Nothing is created or assigned again.
 */
async function updateCustomerProfile(
  http: TwilioHttp,
  i: { accountSid: string; customerProfileSid: string; brand: BrandInfo },
): Promise<void> {
  const assigned = await http.request<Assignments>('GET', `${TH}/CustomerProfiles/${i.customerProfileSid}/EntityAssignments`);
  let businessSid: string | null = null;
  let repSid: string | null = null;
  let addressSid: string | null = null;

  for (const { object_sid: sid } of assigned.results) {
    if (sid.startsWith('IT')) {
      const user = await http.request<EndUserRecord>('GET', `${TH}/EndUsers/${sid}`);
      if (user.type === 'customer_profile_business_information') businessSid = sid;
      if (user.type === 'authorized_representative_1') repSid = sid;
    } else if (sid.startsWith('RD')) {
      const document = await http.request<DocumentRecord>('GET', `${TH}/SupportingDocuments/${sid}`);
      const sids = addressSidsOf(document.attributes?.address_sids);
      const first = sids[0];
      if (document.type === 'customer_profile_address' && first !== undefined) addressSid = first;
    }
  }
  if (businessSid === null || repSid === null || addressSid === null) {
    throw new Error('The texting registration record is incomplete.');
  }

  const { brand } = i;
  await http.request('POST', `${TH}/EndUsers/${businessSid}`, { Attributes: JSON.stringify(businessAttributes(brand)) });
  await http.request('POST', `${TH}/EndUsers/${repSid}`, { Attributes: JSON.stringify(repAttributes(brand)) });
  await http.request('POST', `${TWILIO_API}/Accounts/${i.accountSid}/Addresses/${addressSid}.json`, addressParams(brand));
}

/** Steps 12-15: a new trust product with the messaging end user and the customer profile assigned. */
async function createTrustProduct(
  http: TwilioHttp,
  i: { customerProfileSid: string; companyId: string; brand: BrandInfo; statusCallback: string },
): Promise<string> {
  const { brand } = i;
  const bw = await createSid(http, `${TH}/TrustProducts`, {
    FriendlyName: `Roofline ${i.companyId} messaging`,
    Email: brand.contactEmail,
    PolicySid: A2P_PROFILE_POLICY,
    StatusCallback: i.statusCallback,
  });
  const base = `${TH}/TrustProducts/${bw}`;
  const endUserSid = await createSid(http, `${TH}/EndUsers`, {
    FriendlyName: `${brand.legalName} messaging`,
    Type: 'us_a2p_messaging_profile_information',
    Attributes: JSON.stringify({ company_type: 'private' }),
  });
  await assignTo(http, base, endUserSid);
  await assignTo(http, base, i.customerProfileSid);
  return bw;
}

/** Step 18, or its resubmission (Ruling AE): the failed brand id is resubmitted, never a new brand. */
async function submitBrandRegistration(
  http: TwilioHttp,
  i: { customerProfileSid: string; trustProductSid: string; previousBrandSid: string | null },
): Promise<string> {
  const params = {
    CustomerProfileBundleSid: i.customerProfileSid,
    A2PProfileBundleSid: i.trustProductSid,
    BrandType: 'STANDARD',
  };
  if (i.previousBrandSid !== null) {
    await http.request('POST', `${TWILIO_MESSAGING}/a2p/BrandRegistrations/${i.previousBrandSid}`, params);
    return i.previousBrandSid;
  }
  return createSid(http, `${TWILIO_MESSAGING}/a2p/BrandRegistrations`, params);
}

/**
 * The business profile, messaging profile and brand flow (the brief's Task 26 steps). `http` is already
 * the subaccount client. Raw Twilio errors propagate; brands.ts maps them.
 */
export async function submitBrandFlow(
  http: TwilioHttp,
  i: { sub: { accountSid: string; authToken: string }; primaryProfileSid: string; companyId: string; brand: BrandInfo; statusCallback: string; previous: BrandPrevious },
): Promise<{ customerProfileSid: string; trustProductSid: string; brandSid: string }> {
  const { sub, brand, companyId, statusCallback, previous } = i;

  let customerProfileSid: string;
  if (previous.customerProfileSid === null) {
    customerProfileSid = await createCustomerProfile(http, {
      accountSid: sub.accountSid,
      primaryProfileSid: i.primaryProfileSid,
      companyId,
      brand,
      statusCallback,
    });
  } else {
    customerProfileSid = previous.customerProfileSid;
    await updateCustomerProfile(http, { accountSid: sub.accountSid, customerProfileSid, brand });
  }
  await submitForReview(http, `${TH}/CustomerProfiles/${customerProfileSid}`, SECONDARY_PROFILE_POLICY);

  const trustProductSid =
    previous.trustProductSid ?? (await createTrustProduct(http, { customerProfileSid, companyId, brand, statusCallback }));
  await submitForReview(http, `${TH}/TrustProducts/${trustProductSid}`, A2P_PROFILE_POLICY);

  const brandSid = await submitBrandRegistration(http, {
    customerProfileSid,
    trustProductSid,
    previousBrandSid: previous.brandSid,
  });
  return { customerProfileSid, trustProductSid, brandSid };
}
