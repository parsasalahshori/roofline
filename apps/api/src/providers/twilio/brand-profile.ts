import type { BrandInfo } from '@roofline/shared';
import { RegistrarRejectedError, type BrandProgress } from '../registrar.ts';
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

/** The business end user, assigned to a customer profile. */
async function addBusiness(http: TwilioHttp, base: string, brand: BrandInfo): Promise<void> {
  const sid = await createSid(http, `${TH}/EndUsers`, {
    FriendlyName: brand.legalName,
    Type: 'customer_profile_business_information',
    Attributes: JSON.stringify(businessAttributes(brand)),
  });
  await assignTo(http, base, sid);
}

/** The authorized representative end user, assigned to a customer profile. */
async function addRepresentative(http: TwilioHttp, base: string, brand: BrandInfo): Promise<void> {
  const sid = await createSid(http, `${TH}/EndUsers`, {
    FriendlyName: `${brand.contactFirstName} ${brand.contactLastName}`,
    Type: 'authorized_representative_1',
    Attributes: JSON.stringify(repAttributes(brand)),
  });
  await assignTo(http, base, sid);
}

/** The address and its supporting document, the document assigned to a customer profile. */
async function addAddress(http: TwilioHttp, base: string, accountSid: string, brand: BrandInfo): Promise<void> {
  const addressSid = await createSid(http, `${TWILIO_API}/Accounts/${accountSid}/Addresses.json`, addressParams(brand));
  const documentSid = await createSid(http, `${TH}/SupportingDocuments`, {
    FriendlyName: `${brand.legalName} address`,
    Type: 'customer_profile_address',
    Attributes: JSON.stringify({ address_sids: [addressSid] }),
  });
  await assignTo(http, base, documentSid);
}

/** Steps 1-9: a new customer profile with its business, representative, address and primary profile. */
async function createCustomerProfile(
  http: TwilioHttp,
  i: { accountSid: string; primaryProfileSid: string; companyId: string; brand: BrandInfo; statusCallback: string; onProgress?: (p: BrandProgress) => void },
): Promise<string> {
  const { brand } = i;
  const bu = await createSid(http, `${TH}/CustomerProfiles`, {
    FriendlyName: `Roofline ${i.companyId}`,
    Email: brand.contactEmail,
    PolicySid: SECONDARY_PROFILE_POLICY,
    StatusCallback: i.statusCallback,
  });
  i.onProgress?.({ customerProfileSid: bu });
  const base = `${TH}/CustomerProfiles/${bu}`;

  await addBusiness(http, base, brand);
  await addRepresentative(http, base, brand);
  await addAddress(http, base, i.accountSid, brand);

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
 * updated in place. A part an earlier attempt never made (or the primary profile) is made and assigned now.
 */
async function updateCustomerProfile(
  http: TwilioHttp,
  i: { accountSid: string; primaryProfileSid: string; customerProfileSid: string; brand: BrandInfo },
): Promise<void> {
  const base = `${TH}/CustomerProfiles/${i.customerProfileSid}`;
  const assigned = await http.request<Assignments>('GET', `${TH}/CustomerProfiles/${i.customerProfileSid}/EntityAssignments`);
  let businessSid: string | null = null;
  let repSid: string | null = null;
  let addressSid: string | null = null;
  let hasPrimary = false;

  for (const { object_sid: sid } of assigned.results) {
    if (sid === i.primaryProfileSid) hasPrimary = true;
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
  const { brand } = i;
  // A part an earlier attempt never got to make is made now; the ones that exist are updated in place.
  if (businessSid === null) await addBusiness(http, base, brand);
  else await http.request('POST', `${TH}/EndUsers/${businessSid}`, { Attributes: JSON.stringify(businessAttributes(brand)) });
  if (repSid === null) await addRepresentative(http, base, brand);
  else await http.request('POST', `${TH}/EndUsers/${repSid}`, { Attributes: JSON.stringify(repAttributes(brand)) });
  if (addressSid === null) await addAddress(http, base, i.accountSid, brand);
  else await http.request('POST', `${TWILIO_API}/Accounts/${i.accountSid}/Addresses/${addressSid}.json`, addressParams(brand));
  if (!hasPrimary) await assignTo(http, base, i.primaryProfileSid);
}

/** The messaging end user's create params, shared by a new trust product and the completion of a saved one. */
function messagingEndUserParams(brand: BrandInfo): Record<string, string> {
  return {
    FriendlyName: `${brand.legalName} messaging`,
    Type: 'us_a2p_messaging_profile_information',
    Attributes: JSON.stringify({ company_type: 'private' }),
  };
}

/** A saved trust product an earlier attempt left half built: make and assign whatever it lacks. */
async function completeTrustProduct(
  http: TwilioHttp,
  i: { trustProductSid: string; customerProfileSid: string; brand: BrandInfo },
): Promise<void> {
  const base = `${TH}/TrustProducts/${i.trustProductSid}`;
  const assigned = await http.request<Assignments>('GET', `${base}/EntityAssignments`);
  const sids = assigned.results.map((r) => r.object_sid);
  if (!sids.some((sid) => sid.startsWith('IT'))) {
    const endUserSid = await createSid(http, `${TH}/EndUsers`, messagingEndUserParams(i.brand));
    await assignTo(http, base, endUserSid);
  }
  if (!sids.includes(i.customerProfileSid)) await assignTo(http, base, i.customerProfileSid);
}

/** Steps 12-15: a new trust product with the messaging end user and the customer profile assigned. */
async function createTrustProduct(
  http: TwilioHttp,
  i: { customerProfileSid: string; companyId: string; brand: BrandInfo; statusCallback: string; onProgress?: (p: BrandProgress) => void },
): Promise<string> {
  const { brand } = i;
  const bw = await createSid(http, `${TH}/TrustProducts`, {
    FriendlyName: `Roofline ${i.companyId} messaging`,
    Email: brand.contactEmail,
    PolicySid: A2P_PROFILE_POLICY,
    StatusCallback: i.statusCallback,
  });
  i.onProgress?.({ trustProductSid: bw });
  const base = `${TH}/TrustProducts/${bw}`;
  const endUserSid = await createSid(http, `${TH}/EndUsers`, messagingEndUserParams(brand));
  await assignTo(http, base, endUserSid);
  await assignTo(http, base, i.customerProfileSid);
  return bw;
}

/** Step 18, or its resubmission (Ruling AE): the failed brand id is resubmitted, never a new brand. */
async function submitBrandRegistration(
  http: TwilioHttp,
  i: { customerProfileSid: string; trustProductSid: string; previousBrandSid: string | null; onProgress?: (p: BrandProgress) => void },
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
  const brandSid = await createSid(http, `${TWILIO_MESSAGING}/a2p/BrandRegistrations`, params);
  i.onProgress?.({ brandSid });
  return brandSid;
}

/**
 * The business profile, messaging profile and brand flow (the brief's Task 26 steps). `http` is already
 * the subaccount client. Raw Twilio errors propagate; brands.ts maps them.
 */
export async function submitBrandFlow(
  http: TwilioHttp,
  i: { sub: { accountSid: string; authToken: string }; primaryProfileSid: string; companyId: string; brand: BrandInfo; statusCallback: string; previous: BrandPrevious; onProgress?: (p: BrandProgress) => void },
): Promise<{ customerProfileSid: string; trustProductSid: string; brandSid: string }> {
  const { sub, brand, companyId, statusCallback, previous, onProgress } = i;

  let customerProfileSid: string;
  if (previous.customerProfileSid === null) {
    customerProfileSid = await createCustomerProfile(http, {
      accountSid: sub.accountSid,
      primaryProfileSid: i.primaryProfileSid,
      companyId,
      brand,
      statusCallback,
      ...(onProgress ? { onProgress } : {}),
    });
  } else {
    customerProfileSid = previous.customerProfileSid;
    await updateCustomerProfile(http, { accountSid: sub.accountSid, primaryProfileSid: i.primaryProfileSid, customerProfileSid, brand });
  }
  await submitForReview(http, `${TH}/CustomerProfiles/${customerProfileSid}`, SECONDARY_PROFILE_POLICY);

  let trustProductSid: string;
  if (previous.trustProductSid === null) {
    trustProductSid = await createTrustProduct(http, { customerProfileSid, companyId, brand, statusCallback, ...(onProgress ? { onProgress } : {}) });
  } else {
    trustProductSid = previous.trustProductSid;
    await completeTrustProduct(http, { trustProductSid, customerProfileSid, brand });
  }
  await submitForReview(http, `${TH}/TrustProducts/${trustProductSid}`, A2P_PROFILE_POLICY);

  const brandSid = await submitBrandRegistration(http, {
    customerProfileSid,
    trustProductSid,
    previousBrandSid: previous.brandSid,
    ...(onProgress ? { onProgress } : {}),
  });
  return { customerProfileSid, trustProductSid, brandSid };
}
