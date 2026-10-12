import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildCampaign } from '@roofline/shared';
import { loadConfigOrExit } from '../../deps.ts';
import type { ReviewStatus, SubaccountRef } from '../../providers/registrar.ts';
import { TwilioAccounts } from '../../providers/twilio/accounts.ts';
import { TwilioBrands } from '../../providers/twilio/brands.ts';
import { TwilioHttp } from '../../providers/twilio/http.ts';
import { SmokeRefused, assertConfirmed, parseSmokeBrand } from './guards.ts';

/*
 * Sends the smoke test brand to Twilio for registration, by hand only. It makes a real registration
 * with the phone carriers and costs money, so --submit and --campaign need --confirm-real-registration.
 *
 *   npm run smoke:texting -w @roofline/api -- --submit --confirm-real-registration
 *   npm run smoke:texting -w @roofline/api -- --status
 *   npm run smoke:texting -w @roofline/api -- --campaign --confirm-real-registration \
 *     --privacy-url <url> --terms-url <url>
 *
 * Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PRIMARY_PROFILE_SID, SMOKE_BRAND_JSON (the brand
 * details), optional SMOKE_STATUS_CALLBACK_URL and SMOKE_INBOUND_URL placeholders. The state file
 * (default .smoke-texting.json, git-ignored) holds the subaccount token, so it is never printed.
 * Provider error text is never printed: a failure prints a plain sentence and exits 1.
 */

export const USAGE =
  'Usage: npm run smoke:texting -w @roofline/api -- (--submit | --status | --campaign) [--confirm-real-registration] [--state <path>] [--privacy-url <url>] [--terms-url <url>]';

const PLACEHOLDER_STATUS_URL = 'https://example.invalid/hooks/twilio/smoke';
const PLACEHOLDER_INBOUND_URL = 'https://example.invalid/hooks/twilio/smoke/inbound';
const DEFAULT_STATE_PATH = '.smoke-texting.json';
const COMPANY_ID = 'smoke';
const CONFIRM_FLAG = '--confirm-real-registration';
const MODES = ['--submit', '--status', '--campaign'] as const;
const VALUE_FLAGS = new Set(['--state', '--privacy-url', '--terms-url']);
const GENERIC_FAILURE = 'The texting service turned this down or could not be reached.';

export type SmokeIo = { log(line: string): void; error(line: string): void };

const consoleIo: SmokeIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

type Mode = (typeof MODES)[number];
type Args = {
  mode: Mode;
  argv: readonly string[];
  statePath: string;
  privacyUrl: string | undefined;
  termsUrl: string | undefined;
};

type SmokeState = {
  accountSid: string | null;
  authToken: string | null;
  customerProfileSid: string | null;
  trustProductSid: string | null;
  brandSid: string | null;
  messagingServiceSid: string | null;
  campaignSid: string | null;
};

const STATE_KEYS: ReadonlyArray<keyof SmokeState> = [
  'accountSid',
  'authToken',
  'customerProfileSid',
  'trustProductSid',
  'brandSid',
  'messagingServiceSid',
  'campaignSid',
];

/** Returns the parsed arguments, or null when they are not one valid combination. */
function parseArgs(argv: readonly string[]): Args | null {
  const flags: string[] = [];
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return null;
      values.set(arg, value);
      i++;
    } else if (arg === CONFIRM_FLAG || (MODES as readonly string[]).includes(arg)) {
      if (flags.includes(arg)) return null;
      flags.push(arg);
    } else {
      return null;
    }
  }
  const modes = flags.filter((flag): flag is Mode => (MODES as readonly string[]).includes(flag));
  if (modes.length !== 1) return null;
  const mode = modes[0]!;
  const privacyUrl = values.get('--privacy-url');
  const termsUrl = values.get('--terms-url');
  if (mode === '--campaign' && (!privacyUrl || !termsUrl)) return null;
  return {
    mode,
    argv: flags,
    statePath: values.get('--state') ?? DEFAULT_STATE_PATH,
    privacyUrl,
    termsUrl,
  };
}

function emptyState(): SmokeState {
  return Object.fromEntries(STATE_KEYS.map((key) => [key, null])) as SmokeState;
}

function readState(path: string): SmokeState {
  if (!existsSync(path)) return emptyState();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new SmokeRefused(`${path} could not be read.`);
  }
  const state = emptyState();
  if (typeof raw !== 'object' || raw === null) throw new SmokeRefused(`${path} could not be read.`);
  for (const key of STATE_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'string') state[key] = value;
  }
  return state;
}

function saveState(path: string, state: SmokeState): void {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function requireSubaccount(state: SmokeState): SubaccountRef {
  if (!state.accountSid || !state.authToken) throw new SmokeRefused('Run --submit first.');
  return { accountSid: state.accountSid, authToken: state.authToken };
}

const REVIEW_WORDS: Record<ReviewStatus, string> = {
  approved: 'approved',
  pending: 'pending',
  failed: 'turned down',
};

/** Runs one smoke mode and returns the exit code. */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv, io: SmokeIo = consoleIo): Promise<number> {
  const args = parseArgs(argv);
  if (!args) {
    io.error(USAGE);
    return 1;
  }

  const config = loadConfigOrExit(env);
  const accountSid = config.TWILIO_ACCOUNT_SID;
  const authToken = config.TWILIO_AUTH_TOKEN;
  const primaryProfileSid = config.TWILIO_PRIMARY_PROFILE_SID;
  if (!accountSid || !authToken || !primaryProfileSid) {
    io.error('Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PRIMARY_PROFILE_SID first.');
    return 1;
  }

  const http = new TwilioHttp({ accountSid, authToken });
  const accounts = new TwilioAccounts({ http });
  const brands = new TwilioBrands({ http, primaryProfileSid });
  const inboundUrl = env.SMOKE_INBOUND_URL ?? PLACEHOLDER_INBOUND_URL;
  const statusUrl = env.SMOKE_STATUS_CALLBACK_URL ?? PLACEHOLDER_STATUS_URL;

  try {
    const state = readState(args.statePath);

    if (args.mode === '--submit') {
      assertConfirmed(args.argv, CONFIRM_FLAG);
      const brand = parseSmokeBrand(env.SMOKE_BRAND_JSON);
      const sub = await accounts.ensureSubaccount(COMPANY_ID);
      state.accountSid = sub.accountSid;
      state.authToken = sub.authToken;
      saveState(args.statePath, state);
      const sids = await brands.submitBrand(sub, {
        companyId: COMPANY_ID,
        brand,
        statusCallback: statusUrl,
        previous: {
          customerProfileSid: state.customerProfileSid,
          trustProductSid: state.trustProductSid,
          brandSid: state.brandSid,
        },
      });
      state.customerProfileSid = sids.customerProfileSid;
      state.trustProductSid = sids.trustProductSid;
      state.brandSid = sids.brandSid;
      saveState(args.statePath, state);
      io.log('Brand sent for review. Run --status to check it (it can take days).');
      return 0;
    }

    const sub = requireSubaccount(state);

    if (args.mode === '--status') {
      if (!state.brandSid) throw new SmokeRefused('Run --submit first.');
      const brand = await brands.brandStatus(sub, state.brandSid);
      io.log(`Brand: ${REVIEW_WORDS[brand.status]}`);
      if (state.campaignSid && state.messagingServiceSid) {
        const campaign = await brands.campaignStatus(sub, state.messagingServiceSid, state.campaignSid);
        io.log(`Campaign: ${REVIEW_WORDS[campaign.status]}`);
      }
      return 0;
    }

    // --campaign
    assertConfirmed(args.argv, CONFIRM_FLAG);
    if (!state.brandSid) throw new SmokeRefused('Run --submit first.');
    const brand = parseSmokeBrand(env.SMOKE_BRAND_JSON);
    const brandStatus = await brands.brandStatus(sub, state.brandSid);
    if (brandStatus.status !== 'approved') {
      io.error('The brand is not approved yet. Run --status again later.');
      return 1;
    }
    const messaging = await accounts.ensureMessagingService(sub, COMPANY_ID, {
      inbound: inboundUrl,
      status: statusUrl,
    });
    state.messagingServiceSid = messaging.messagingServiceSid;
    saveState(args.statePath, state);
    const campaign = buildCampaign({
      companyName: brand.legalName,
      companyPhone: brand.contactPhone,
      privacyUrl: args.privacyUrl!,
      termsUrl: args.termsUrl!,
    });
    const sent = await brands.submitCampaign(sub, {
      brandSid: state.brandSid,
      messagingServiceSid: messaging.messagingServiceSid,
      campaign,
      previousCampaignSid: state.campaignSid,
    });
    state.campaignSid = sent.campaignSid;
    saveState(args.statePath, state);
    io.log('Campaign sent for review. Run --status to check it.');
    return 0;
  } catch (err) {
    io.error(err instanceof SmokeRefused ? err.message : GENERIC_FAILURE);
    return 1;
  }
}

/** True when this file is the script being run, not a module a test imported. */
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
