import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Config } from '../../config.ts';
import { loadConfigOrExit } from '../../deps.ts';
import { type AdCreate, type AdStats, AdPlatformError, type Circle } from '../../providers/ads-google.ts';
import type { BroadcastMail } from '../../providers/broadcast.ts';
import type { MetaCreate } from '../../providers/ads-meta.ts';
import { googleAdsFor } from '../../providers/google-ads/index.ts';
import { type GoogleAdsSettings, createGoogleAdsHttp } from '../../providers/google-ads/http.ts';
import { appSecretProof } from '../../providers/meta/http.ts';
import { metaAdsFor } from '../../providers/meta/index.ts';
import { resvgCardFor } from '../../providers/resvg-card.ts';
import { postmarkBroadcastFor } from '../../providers/postmark-broadcast.ts';
import { unsubscribeKey } from '../../public/unsubscribe-key.ts';
import { signUnsubscribeToken } from '../../public/unsubscribe-token.ts';
import {
  SMOKE_BUDGET_CENTS,
  SmokeRefused,
  assertGoogleSmokeAllowed,
  assertStormConfirmed,
  assertUnsubscribeLink,
  parseGoogleTestAccount,
  parseStormArgs,
  scrubFixture,
  smokeNameTag,
} from './storm-guards.ts';

/*
 * Runs the S1 storm smoke by hand, against the real providers, with the owner's own test accounts:
 *
 *   npm run smoke:storm -w @roofline/api -- --confirm-real-providers [--google <id>] [--meta <id>] [--email <address>]
 *
 * Steps: a read-only MESH listing check (always), then one paused Google test campaign, one paused
 * Meta test campaign that is deleted again, and one broadcast email with a working unsubscribe link.
 * Each step runs only when its flag is given. Run it by hand only, with the test credentials in the
 * environment. Nothing here is run by CI or the unit suite. Secrets, provider error text and raw
 * emails or account ids are never printed; only the step, a status word, or an error kind is shown.
 */

export type SmokeIo = { log(line: string): void; error(line: string): void };

const consoleIo: SmokeIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export type StormSmokeOptions = { fetchImpl?: typeof fetch };

const STOPPED = 'The storm smoke run stopped. Check the test credentials and the step above.';
const TIMEOUT_MS = 30_000;
const DAY_MS = 86_400_000;

const MESH_LISTING_URL =
  'https://noaa-mrms-pds.s3.amazonaws.com/?list-type=2&prefix=CONUS/MESH_Max_1440min_00.50/&max-keys=5';
const KEY_PATTERN = /<Key>([^<]+)<\/Key>/g;
const KEY_TIME = /(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/;

const META_GRAPH_BASE = 'https://graph.facebook.com';

/** The fixed smoke company id used for the unsubscribe token. The /u/ page proves the token verifies, not a real opt-out. */
const SMOKE_COMPANY_ID = '00000000-0000-4000-8000-000000000029';

const SMOKE_CIRCLES: Circle[] = [{ lat: 32.7767, lng: -96.797, radiusM: 8000 }];

/** Campaigns are paused and carry the smoke copy only. */
const SMOKE_COPY = {
  headline: 'Smoke test',
  description: 'Smoke test, paused and removed',
  companyName: 'Roofline Smoke',
  city: 'Dallas',
} as const;

/** The stamp keeps name tags unique per minute: `YYYYMMDDHHMM`. */
function runStamp(): string {
  return new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
}

/** A UTC calendar day as YYYY-MM-DD, offset from today. */
function utcDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

/** Reads the status, then pauses once and reads again if it is not paused yet. Throws when it still is not. */
async function ensurePaused(
  readStats: () => Promise<AdStats>,
  pause: () => Promise<void>,
): Promise<AdStats> {
  let current = await readStats();
  if (current.status !== 'paused') {
    await pause();
    current = await readStats();
  }
  if (current.status !== 'paused') {
    throw new SmokeRefused('The test campaign is not paused. Pause it by hand before you go on.');
  }
  return current;
}

async function meshStep(fetchImpl: typeof fetch, io: SmokeIo, captured: Record<string, unknown>): Promise<void> {
  io.log('1. MESH: reading the NOAA listing (read only, nothing is downloaded).');
  const res = await fetchImpl(MESH_LISTING_URL, { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error('The MESH listing request failed.');
  const xml = await res.text();
  const keys = [...xml.matchAll(KEY_PATTERN)].map((match) => match[1] ?? '');
  const last = keys.length > 0 ? keys[keys.length - 1] : undefined;
  const time = last === undefined ? null : KEY_TIME.exec(last);
  const lastTime =
    time === null
      ? null
      : `${time[1]}-${time[2]}-${time[3]} ${time[4]}:${time[5]}:${time[6]} UTC`;
  io.log(`  Files in the listing: ${keys.length}`);
  io.log(`  Timestamp of the last file listed: ${lastTime ?? 'none found'}`);
  io.log('  Run the hail runbook next (docs/superpowers/s1-manual-smoke.md, check (a)) and compare with the NOAA MRMS viewer.');
  captured.mesh = { listedFiles: keys.length, lastFileTime: lastTime };
}

/** Removes a Google campaign with one mutate call. Error text is never printed. Returns false on any failure. */
async function removeGoogleCampaign(
  http: ReturnType<typeof createGoogleAdsHttp>,
  customerId: string,
  campaignId: string,
): Promise<boolean> {
  if (!/^\d+$/.test(campaignId)) return false;
  try {
    await http.mutate(customerId, [
      { campaignOperation: { remove: `customers/${customerId}/campaigns/${campaignId}` } },
    ]);
    return true;
  } catch {
    return false;
  }
}

async function googleStep(
  config: Config,
  customerId: string,
  understandSpend: boolean,
  fetchImpl: typeof fetch,
  io: SmokeIo,
  captured: Record<string, unknown>,
): Promise<void> {
  const { GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_MANAGER_ID, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN } =
    config;
  if (
    !GOOGLE_ADS_DEVELOPER_TOKEN ||
    !GOOGLE_ADS_MANAGER_ID ||
    !GOOGLE_ADS_CLIENT_ID ||
    !GOOGLE_ADS_CLIENT_SECRET ||
    !GOOGLE_ADS_REFRESH_TOKEN
  ) {
    throw new SmokeRefused('Google Ads is not set up: all five GOOGLE_ADS settings are needed.');
  }
  const settings: GoogleAdsSettings = {
    developerToken: GOOGLE_ADS_DEVELOPER_TOKEN,
    managerId: GOOGLE_ADS_MANAGER_ID,
    clientId: GOOGLE_ADS_CLIENT_ID,
    clientSecret: GOOGLE_ADS_CLIENT_SECRET,
    refreshToken: GOOGLE_ADS_REFRESH_TOKEN,
    apiVersion: config.GOOGLE_ADS_API_VERSION,
  };
  const ads = googleAdsFor(config, fetchImpl);
  if (ads === null) {
    throw new SmokeRefused('Google Ads is not set up: all five GOOGLE_ADS settings are needed.');
  }

  io.log('2. Google Ads: link status and account info.');
  const linkStatus = await ads.linkStatus(customerId);
  io.log(`  Link status: ${linkStatus}`);
  const info = await ads.accountInfo(customerId);
  io.log(`  Account: ${info.name} (${info.currency})`);
  captured.google = { linkStatus, accountInfo: info };

  const http = createGoogleAdsHttp(settings, fetchImpl);
  const rows = await http.search(
    customerId,
    'SELECT customer.test_account FROM customer',
  );
  const isTestAccount = parseGoogleTestAccount(rows);
  io.log(`  Google test account: ${isTestAccount ? 'yes' : 'no'}`);
  // The budget is $1 in both cases: a test account is capped at the same smoke amount.
  assertGoogleSmokeAllowed({
    isTestAccount,
    understandSpend,
    dailyBudgetCents: SMOKE_BUDGET_CENTS,
  });

  const nameTag = smokeNameTag('google', runStamp());
  const existingGoogle = await ads.findCampaign(customerId, nameTag);
  let campaignId: string;
  if (existingGoogle !== null) {
    campaignId = existingGoogle;
    io.log('  Reusing the smoke campaign from this minute.');
  } else {
    const create: AdCreate = {
      accountId: customerId,
      nameTag,
      dailyBudgetCents: SMOKE_BUDGET_CENTS,
      startDate: utcDay(0),
      endDate: utcDay(1),
      circles: SMOKE_CIRCLES,
      landingUrl: config.PUBLIC_BASE_URL,
      keywords: ['roof repair'],
      ...SMOKE_COPY,
    };
    const created = await ads.createCampaign(create);
    campaignId = created.campaignId;
    io.log('  Campaign created paused.');
  }

  // Check and pause first; on a non-test account always try the removal, so a failed check does not leave the campaign behind.
  const googleCampaign: string = campaignId;
  let checkError: unknown = null;
  let stats: AdStats | null = null;
  try {
    stats = await ensurePaused(
      () => ads.stats(customerId, googleCampaign),
      () => ads.setStatus(customerId, googleCampaign, 'paused'),
    );
  } catch (err) {
    checkError = err;
  }
  if (stats !== null) {
    io.log(`  Status: ${stats.status}; spend ${stats.spendCents} cents, impressions ${stats.impressions}, clicks ${stats.clicks}`);
    captured.googleStats = stats;
  }

  if (isTestAccount) {
    if (checkError !== null) throw checkError;
    io.log('  The paused test campaign stays in the Google test account.');
    return;
  }
  const removed = await removeGoogleCampaign(http, customerId, googleCampaign);
  if (!removed) {
    throw new SmokeRefused('REMOVE THE CAMPAIGN BY HAND in the Google Ads UI now.');
  }
  io.log('  Removed the Google test campaign.');
  if (checkError !== null) throw checkError;
}

/** Deletes a Meta campaign with a direct Graph call. The URL is never printed. Returns false on any failure. */
async function deleteMetaCampaign(
  config: Config,
  token: string,
  appSecret: string,
  campaignId: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const proof = appSecretProof(token, appSecret);
  const url =
    `${META_GRAPH_BASE}/${config.META_GRAPH_VERSION}/${encodeURIComponent(campaignId)}` +
    `?access_token=${encodeURIComponent(token)}&appsecret_proof=${proof}`;
  try {
    const res = await fetchImpl(url, { method: 'DELETE', signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.text();
    return res.ok;
  } catch {
    return false;
  }
}

async function metaStep(
  config: Config,
  adAccountId: string,
  fetchImpl: typeof fetch,
  io: SmokeIo,
  captured: Record<string, unknown>,
): Promise<void> {
  const { META_APP_SECRET, META_SYSTEM_USER_TOKEN } = config;
  const ads = metaAdsFor(config, fetchImpl);
  if (ads === null || !META_APP_SECRET || !META_SYSTEM_USER_TOKEN) {
    throw new SmokeRefused('Meta ads are not set up: all four META settings are needed.');
  }

  io.log('3. Meta: verifying access to the test ad account.');
  const access = await ads.verifyAccess(adAccountId);
  if (!access.ok) {
    throw new SmokeRefused(`Meta will not use this ad account (${access.reason}). Share it with the system user, then run again.`);
  }
  io.log(`  Access ok: ${access.name} (${access.currency})`);
  captured.metaAccess = access;

  const imagePng: Uint8Array = await resvgCardFor(config).card({
    companyName: SMOKE_COPY.companyName,
    line: SMOKE_COPY.headline,
    colorHex: '#1d4ed8',
  });
  io.log(`  Card image upload: ${imagePng.byteLength} bytes (rendered ad card)`);

  const nameTag = smokeNameTag('meta', runStamp());
  const existingMeta = await ads.findCampaign(adAccountId, nameTag);
  let campaignId: string;
  if (existingMeta !== null) {
    campaignId = existingMeta;
    io.log('  Reusing the smoke campaign from this minute.');
  } else {
    const create: MetaCreate = {
      accountId: adAccountId,
      nameTag,
      dailyBudgetCents: SMOKE_BUDGET_CENTS,
      startDate: utcDay(0),
      endDate: utcDay(1),
      circles: SMOKE_CIRCLES,
      landingUrl: config.PUBLIC_BASE_URL,
      primaryText: 'Smoke test, paused',
      imagePng,
      housing: false,
      ...SMOKE_COPY,
    };
    const created = await ads.createCampaign(create);
    campaignId = created.campaignId;
    io.log('  Campaign created paused.');
  }

  // Check and pause first, then always try the delete, so a failed check does not leave the campaign behind.
  const metaCampaign: string = campaignId;
  let checkError: unknown = null;
  let stats: AdStats | null = null;
  try {
    stats = await ensurePaused(
      () => ads.stats(adAccountId, metaCampaign),
      () => ads.setStatus(adAccountId, metaCampaign, 'paused'),
    );
  } catch (err) {
    checkError = err;
  }

  const deleted = await deleteMetaCampaign(config, META_SYSTEM_USER_TOKEN, META_APP_SECRET, metaCampaign, fetchImpl);
  if (!deleted) {
    throw new SmokeRefused('DELETE THE CAMPAIGN BY HAND in Meta Ads Manager now.');
  }
  io.log('  Deleted the Meta test campaign.');
  if (checkError !== null) throw checkError;
  if (stats !== null) {
    io.log(`  Status before delete: ${stats.status}; spend ${stats.spendCents} cents, impressions ${stats.impressions}, clicks ${stats.clicks}`);
    captured.metaStats = stats;
  }
}

async function emailStep(config: Config, to: string, io: SmokeIo): Promise<void> {
  const mailer = postmarkBroadcastFor(config);
  if (mailer === null) throw new SmokeRefused('Broadcast email is not set up.');
  const from = config.STORM_MAIL_FROM ?? config.MAIL_FROM;
  if (!from) throw new SmokeRefused('Set STORM_MAIL_FROM or MAIL_FROM before the email step.');

  io.log('4. Email: one broadcast test message with a working unsubscribe link.');
  const token = signUnsubscribeToken(unsubscribeKey(config), { companyId: SMOKE_COMPANY_ID, email: to });
  const unsubscribeUrl = `${config.APP_ORIGIN}/u/${token}`;
  const line = 'Roofline test email, no action needed.';
  const mail: BroadcastMail = {
    to,
    from,
    replyTo: null,
    subject: 'Roofline smoke test',
    text: `${line}\n\nUnsubscribe: ${unsubscribeUrl}\n`,
    html: `<p>${line}</p><p><a href="${unsubscribeUrl}">Unsubscribe</a></p>`,
    unsubscribeUrl,
    tag: 'roofline-smoke',
  };
  assertUnsubscribeLink(mail, config.APP_ORIGIN);
  await mailer.send(mail);
  io.log('  sent');
  io.log('  Open the email and click the unsubscribe link once, then record it in the runbook sign-off.');
}

/** Runs the smoke flow and returns the exit code (0 when done, 1 when refused or stopped). */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: SmokeIo = consoleIo,
  options: StormSmokeOptions = {},
): Promise<number> {
  const fetchImpl: typeof fetch = options.fetchImpl ?? globalThis.fetch;
  const captured: Record<string, unknown> = {};
  try {
    assertStormConfirmed(argv);
    const args = parseStormArgs(argv);
    if (args.google === null && args.meta === null && args.email === null) {
      throw new SmokeRefused('Pass at least one of --google, --meta or --email.');
    }
    const config = loadConfigOrExit(env);

    await meshStep(fetchImpl, io, captured);
    if (args.google !== null) {
      await googleStep(config, args.google, args.understandSpend, fetchImpl, io, captured);
    }
    if (args.meta !== null) {
      await metaStep(config, args.meta, fetchImpl, io, captured);
    }
    if (args.email !== null) {
      await emailStep(config, args.email, io);
    }

    io.log('5. Scrubbed capture for the Task 17/18 fixtures:');
    io.log(JSON.stringify(scrubFixture(captured), null, 2));
    return 0;
  } catch (err) {
    if (err instanceof SmokeRefused) {
      io.error(err.message);
      return 1;
    }
    if (err instanceof AdPlatformError) {
      io.error(`The ad platform reported "${err.kind}". The run stopped at the step above.`);
      return 1;
    }
    io.error(STOPPED);
    return 1;
  }
}

/** True when this file is the script being run (`tsx src/scripts/smoke/storm.ts`), not a module a test imported. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
