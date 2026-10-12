import { hkdfSync } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const required = { error: 'is required' } as const;

/** A whole number from an env string, with a default when the variable is unset. */
function integer(fallback: number, min: number, max: number) {
  return z
    .string()
    .regex(/^\d+$/, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().min(min, `must be at least ${min}`).max(max, `must be at most ${max}`))
    .default(fallback);
}

const httpUrl = z.string(required).refine((v) => {
  try {
    const { protocol } = new URL(v);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}, 'must be an http(s) URL, for example https://app.example.com');

const postgresUrl = z
  .string(required)
  .refine((v) => /^postgres(ql)?:\/\//.test(v), 'must be a postgres:// connection URL');

/** 32 random bytes, base64: `openssl rand -base64 32`. Checked by decoding and re-encoding. */
const encryptionKey = z.string(required).refine((v) => {
  const bytes = Buffer.from(v, 'base64');
  return bytes.length === 32 && bytes.toString('base64') === v;
}, 'must be 32 random bytes, base64-encoded (openssl rand -base64 32)');

/** The repository root (this file is apps/api/src/config.ts). A relative WEB_DIST_DIR is read from here. */
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function isBuiltWebApp(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && statSync(path.join(dir, 'index.html')).isFile();
  } catch {
    return false; // missing, or not readable
  }
}

/**
 * The built web app: a directory that contains index.html. A relative path is taken from the
 * repository root, not the working directory, because `npm start -w @roofline/api` runs in
 * apps/api; the value kept is the absolute path. The message never prints the path.
 */
const webDistDir = z
  .string()
  .transform((v) => path.resolve(REPO_ROOT, v))
  .refine(isBuiltWebApp, 'must be a directory that contains index.html (build the web app first: npm run build:web)');

/** An on/off switch from an env string: `1` or `true` is yes, `0` or `false` is no; unset stays unset. */
const flag = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(['1', 'true', '0', 'false'], { error: 'must be 1, true, 0 or false' }))
  .transform((v) => v === '1' || v === 'true')
  .optional();

/** Like `flag`, but unset is `false`, so the key is always a boolean afterwards. */
const flagDefault = (fallback: boolean) =>
  z
    .string()
    .transform((v) => v.trim().toLowerCase())
    .pipe(z.enum(['1', 'true', '0', 'false'], { error: 'must be 1, true, 0 or false' }))
    .transform((v) => v === '1' || v === 'true')
    .default(fallback);

/** A bare hostname (lowercase, checked after folding case): `roofline.app`, `policies.example.co`. */
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/** The example plans file, shipped with the repository; the default outside production. */
const EXAMPLE_BILLING_PLANS = 'config/billing-plans.example.json';

/** The footprint files published by Microsoft (US Building Footprints); the default FOOTPRINTS_BASE_URL. */
const DEFAULT_FOOTPRINTS_BASE_URL = 'https://usbuildingdata.blob.core.windows.net/usbuildings-v2/';

/**
 * The domain storm email comes from by default: the domain part of MAIL_FROM (after the last `@`,
 * without a trailing `>`), else POLICY_PAGES_DOMAIN, else the host of PUBLIC_BASE_URL.
 */
function mailDomain(cfg: { MAIL_FROM?: string; POLICY_PAGES_DOMAIN?: string; PUBLIC_BASE_URL: string }): string {
  if (cfg.MAIL_FROM) {
    const domain = cfg.MAIL_FROM.slice(cfg.MAIL_FROM.lastIndexOf('@') + 1)
      .replace(/>\s*$/, '')
      .trim();
    if (domain) return domain;
  }
  return cfg.POLICY_PAGES_DOMAIN ?? new URL(cfg.PUBLIC_BASE_URL).hostname;
}

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production'], {
      error: (iss) => (iss.input === undefined ? 'is required' : 'must be development, test or production'),
    }),
    /** The one origin the web app is served from. Mutations from any other Origin are refused. */
    APP_ORIGIN: httpUrl.transform((v) => new URL(v).origin),
    DATABASE_URL_TENANT: postgresUrl,
    DATABASE_URL_SYSTEM: postgresUrl,
    ENCRYPTION_KEY: encryptionKey,
    /** Public base URL, used to build links in emails and webhook URLs. No trailing slash. */
    PUBLIC_BASE_URL: httpUrl.transform((v) => v.replace(/\/+$/, '')),

    GOOGLE_CLIENT_ID: z.string().optional(),
    /** Google OAuth client secret. Needs GOOGLE_CLIENT_ID. Unset: Google Calendar connections are off. */
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    /** Microsoft app client id. Set with MICROSOFT_CLIENT_SECRET, or neither. Unset: Outlook connections are off. */
    MICROSOFT_CLIENT_ID: z.string().optional(),
    /** Microsoft app client secret. Set with MICROSOFT_CLIENT_ID, or neither. */
    MICROSOFT_CLIENT_SECRET: z.string().optional(),
    POSTMARK_TOKEN: z.string().optional(),
    /** The From header for outgoing email, for example `Roofline <hello@example.com>`. */
    MAIL_FROM: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    /** Stripe secret key (`sk_`). Unset: billing is off and no Stripe call is made. */
    STRIPE_SECRET_KEY: z
      .string()
      .refine((v) => v.startsWith('sk_'), 'must start with sk_')
      .optional(),
    /** Secret for checking Stripe webhook signatures (`whsec_`); required when STRIPE_SECRET_KEY is set. */
    STRIPE_WEBHOOK_SECRET: z
      .string()
      .refine((v) => v.startsWith('whsec_'), 'must start with whsec_')
      .optional(),
    /**
     * The billing plans file (JSON, read by `billingConfig`). Resolved from the repository root, like
     * WEB_DIST_DIR. Unset: the example file outside production (applied in the final transform).
     */
    BILLING_PLANS_FILE: z
      .string()
      .transform((v) => path.resolve(REPO_ROOT, v))
      .optional(),
    /** Geocodio API key (address lookup). Unset: addresses are not looked up. */
    GEOCODIO_API_KEY: z.string().optional(),
    /** Twilio account SID (`AC` + 32 hex digits). When set, TWILIO_AUTH_TOKEN is required. */
    TWILIO_ACCOUNT_SID: z
      .string()
      .regex(/^AC[0-9a-f]{32}$/, 'must be AC followed by 32 hex digits')
      .optional(),
    /** The Twilio primary customer profile SID (`BU` + 32 hex digits). */
    TWILIO_PRIMARY_PROFILE_SID: z
      .string()
      .regex(/^BU[0-9a-f]{32}$/, 'must be BU followed by 32 hex digits')
      .optional(),
    /** The bare hostname the policy pages are served from, like roofline.app. Case is folded. */
    POLICY_PAGES_DOMAIN: z
      .string()
      .transform((v) => v.toLowerCase())
      .refine((v) => HOSTNAME.test(v), 'must be a bare hostname, like roofline.app')
      .optional(),
    /** Development and tests only: use the fake providers for every outside service. Refused in production. */
    FAKE_PROVIDERS: flag,

    /**
     * Where the built web app is (apps/web/dist). When set, the API serves it too, so one process
     * answers the app and the API (production, and the end-to-end stack). Unset: the API serves
     * only /api, /hooks and /health, and the browser gets the app from Vite.
     */
    WEB_DIST_DIR: webDistDir.optional(),
    /**
     * How the weather service is told who is asking (it wants a name and a way to reach you).
     * Unset: `Roofline (<PUBLIC_BASE_URL>)`, chosen where the source is built (deps.ts).
     */
    NWS_USER_AGENT: z
      .string()
      // It becomes an HTTP header, and a header with other characters makes every request fail.
      .regex(/^[\x20-\x7e]+$/, 'must be plain ASCII text, like Roofline (ops@example.com)')
      .optional(),
    /** `1` or `true` turns weather off (the null source: no network). `0` or `false` leaves it on. */
    WEATHER_DISABLED: flag,

    // D1 Front Desk
    /** Anthropic API key. Unset: Front Desk is off (no model call is made). */
    ANTHROPIC_API_KEY: z.string().optional(),
    FRONT_DESK_ROUTER_MODEL: z.string().min(1).default('claude-haiku-5-5'),
    FRONT_DESK_ANSWER_MODEL: z.string().min(1).default('claude-opus-5-5'),
    /** `1` or `true` asks for the faster Opus output mode. */
    FRONT_DESK_OPUS_FAST: flagDefault(false),
    /** The most calls Front Desk answers at once. */
    FRONT_DESK_MAX_CALLS: integer(40, 1, 1000),
    /** The wss:// URL Twilio ConversationRelay connects to. Unset: PUBLIC_BASE_URL with the wss scheme and /relay. */
    RELAY_PUBLIC_URL: z
      .string()
      .refine((v) => {
        try {
          const { protocol } = new URL(v);
          return protocol === 'wss:' || protocol === 'ws:';
        } catch {
          return false;
        }
      }, 'must be a wss:// URL')
      .optional(),
    /** Roofline's own Twilio number, for forwarding tests. */
    TWILIO_TEST_CALLER_NUMBER: z
      .string()
      .regex(/^\+[1-9]\d{6,14}$/, 'must be an E.164 number like +14025550100')
      .optional(),
    /** Signs relay tokens; at least 32 bytes. Unset: derived from ENCRYPTION_KEY. */
    RELAY_TOKEN_SECRET: z
      .string()
      .refine((v) => Buffer.byteLength(v, 'utf8') >= 32, 'must be at least 32 bytes')
      .optional(),

    /**
     * How many reverse-proxy hops to trust for `req.ip` (0 = none), passed to Express's
     * `trust proxy`. Every IP-keyed rate limit and the audit log's addresses depend on it.
     * Required in production, and at least 1: Render puts one proxy in front of the service, so 1
     * there. With 0 behind a proxy every visitor looks like the proxy and shares one IP limit; a
     * value above the real hop count lets clients choose their IP through X-Forwarded-For.
     * Development and tests default to 0 (nothing in front).
     */
    TRUST_PROXY: integer(0, 0, 32),
    /** Per-session request limit for /api/*. Parsed here, applied by the rate limiter. */
    API_RATE_LIMIT_PER_MIN: integer(600, 1, 1_000_000),
    PORT: integer(4400, 1, 65535),
    /**
     * The address to listen on. Unset: `0.0.0.0` (every interface) in production, where the host's
     * health check and router reach the process from outside its container; `127.0.0.1` otherwise,
     * so a development server is not on the LAN. A HOST that is set always wins.
     */
    HOST: z.string().min(1).optional(),

    /** EagleView API client id. Set with EAGLEVIEW_CLIENT_SECRET, or neither. Unset: aerial and exact reports are off. */
    EAGLEVIEW_CLIENT_ID: z.string().optional(),
    /** EagleView API client secret. Set with EAGLEVIEW_CLIENT_ID, or neither. */
    EAGLEVIEW_CLIENT_SECRET: z.string().optional(),
    /** Which EagleView environment to call. Default: sandbox. */
    EAGLEVIEW_ENV: z.enum(['sandbox', 'production'], { error: 'must be sandbox or production' }).default('sandbox'),
    /** The EagleView product id to order. 0 is a placeholder: ask before ordering anything. */
    EAGLEVIEW_PRODUCT_ID: integer(0, 0, 2_147_483_647),
    /** Cloudflare R2 account id. All four R2 settings come together, or none; production requires them. Unset: signed proposals cannot be stored. */
    R2_ACCOUNT_ID: z.string().optional(),
    /** R2 access key id. See R2_ACCOUNT_ID. */
    R2_ACCESS_KEY_ID: z.string().optional(),
    /** R2 secret access key. See R2_ACCOUNT_ID. */
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    /** R2 bucket name. See R2_ACCOUNT_ID. */
    R2_BUCKET: z.string().optional(),
    /** The base URL of customer proposal links. No trailing slash. Must be on APP_ORIGIN's origin. Unset: APP_ORIGIN (applied in the final transform). */
    PROPOSAL_LINK_BASE_URL: httpUrl.transform((v) => v.replace(/\/+$/, '')).optional(),
    /** Where the building footprint files are read from. Always ends in a slash. Default: the Microsoft US buildings set. */
    FOOTPRINTS_BASE_URL: httpUrl.transform((v) => (v.endsWith('/') ? v : `${v}/`)).default(DEFAULT_FOOTPRINTS_BASE_URL),

    /** Google Ads developer token. All five GOOGLE_ADS settings come together, or none. Unset: Google ads are off. */
    GOOGLE_ADS_DEVELOPER_TOKEN: z.string().optional(),
    /** The Google Ads manager (MCC) account id that clients are linked under. See GOOGLE_ADS_DEVELOPER_TOKEN. */
    GOOGLE_ADS_MANAGER_ID: z.string().optional(),
    /** Google Ads OAuth client id. See GOOGLE_ADS_DEVELOPER_TOKEN. */
    GOOGLE_ADS_CLIENT_ID: z.string().optional(),
    /** Google Ads OAuth client secret. See GOOGLE_ADS_DEVELOPER_TOKEN. */
    GOOGLE_ADS_CLIENT_SECRET: z.string().optional(),
    /** Google Ads OAuth refresh token. See GOOGLE_ADS_DEVELOPER_TOKEN. */
    GOOGLE_ADS_REFRESH_TOKEN: z.string().optional(),
    /** The Google Ads API version to call, like v21. */
    GOOGLE_ADS_API_VERSION: z.string().regex(/^v\d+$/, 'must look like v21').default('v21'),
    /** Meta app id. All four META settings come together, or none. Unset: Meta ads are off. */
    META_APP_ID: z.string().optional(),
    /** Meta app secret. See META_APP_ID. */
    META_APP_SECRET: z.string().optional(),
    /** Meta system user token. See META_APP_ID. */
    META_SYSTEM_USER_TOKEN: z.string().optional(),
    /** The Meta business id that ad accounts are shared with. See META_APP_ID. */
    META_BUSINESS_ID: z.string().optional(),
    /** The Meta Graph API version to call, like v24.0. */
    META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/, 'must look like v24.0').default('v24.0'),
    /** The Postmark message stream for storm alerts and other broadcast email. */
    POSTMARK_BROADCAST_STREAM: z.string().min(1).default('broadcast'),
    /** Basic-auth password Postmark's webhook calls us with at /hooks/postmark. Unset: the webhook refuses every call. */
    POSTMARK_WEBHOOK_SECRET: z.string().min(16, 'must be at least 16 characters').optional(),
    /** The plain From address for storm email, like storms@roofline.app. Unset: `storms@` + the mail domain (final transform). */
    STORM_MAIL_FROM: z.string().email('must be an email address').optional(),
    /** Minutes without a fresh hail report before the hail feed counts as stale. */
    HAIL_STALE_MINUTES: integer(90, 1, 10080),
    /** Where the hail-health schedule emails ops when the hail data goes stale. Unset: it only logs. */
    OPS_ALERT_EMAIL: z.string().email('must be an email address').optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.GOOGLE_CLIENT_SECRET && !cfg.GOOGLE_CLIENT_ID) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_CLIENT_ID'],
        message: 'is required when GOOGLE_CLIENT_SECRET is set',
      });
    }
    if (cfg.MICROSOFT_CLIENT_ID && !cfg.MICROSOFT_CLIENT_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['MICROSOFT_CLIENT_SECRET'],
        message: 'is required when MICROSOFT_CLIENT_ID is set',
      });
    }
    if (cfg.MICROSOFT_CLIENT_SECRET && !cfg.MICROSOFT_CLIENT_ID) {
      ctx.addIssue({
        code: 'custom',
        path: ['MICROSOFT_CLIENT_ID'],
        message: 'is required when MICROSOFT_CLIENT_SECRET is set',
      });
    }
    if (cfg.POSTMARK_TOKEN && !cfg.MAIL_FROM) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_FROM'],
        message: 'is required when POSTMARK_TOKEN is set (Postmark needs a verified From address)',
      });
    }
    if (cfg.STRIPE_SECRET_KEY && !cfg.STRIPE_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['STRIPE_WEBHOOK_SECRET'],
        message: 'is required when STRIPE_SECRET_KEY is set',
      });
    }
    if (cfg.STRIPE_SECRET_KEY && cfg.NODE_ENV === 'production' && !cfg.BILLING_PLANS_FILE) {
      ctx.addIssue({
        code: 'custom',
        path: ['BILLING_PLANS_FILE'],
        message: 'is required in production when STRIPE_SECRET_KEY is set',
      });
    }
    if (cfg.TWILIO_ACCOUNT_SID && !cfg.TWILIO_AUTH_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['TWILIO_AUTH_TOKEN'],
        message: 'is required when TWILIO_ACCOUNT_SID is set',
      });
    }
    if (cfg.EAGLEVIEW_CLIENT_ID && !cfg.EAGLEVIEW_CLIENT_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['EAGLEVIEW_CLIENT_SECRET'],
        message: 'is required when EAGLEVIEW_CLIENT_ID is set',
      });
    }
    if (cfg.EAGLEVIEW_CLIENT_SECRET && !cfg.EAGLEVIEW_CLIENT_ID) {
      ctx.addIssue({
        code: 'custom',
        path: ['EAGLEVIEW_CLIENT_ID'],
        message: 'is required when EAGLEVIEW_CLIENT_SECRET is set',
      });
    }
    const r2 = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const;
    if (r2.some((name) => cfg[name])) {
      for (const name of r2) {
        if (!cfg[name]) {
          ctx.addIssue({ code: 'custom', path: [name], message: 'is required when the other R2 settings are set' });
        }
      }
    } else if (cfg.NODE_ENV === 'production') {
      // Ruling ET: a homeowner can sign only when the signed proposal can be stored, so production needs R2.
      for (const name of r2) {
        ctx.addIssue({ code: 'custom', path: [name], message: 'is required in production (signed proposals are stored in R2)' });
      }
    }
    // The homeowner page signs and declines with POST requests, which are only taken from APP_ORIGIN.
    if (cfg.PROPOSAL_LINK_BASE_URL !== undefined && originOf(cfg.PROPOSAL_LINK_BASE_URL) !== originOf(cfg.APP_ORIGIN)) {
      ctx.addIssue({
        code: 'custom',
        path: ['PROPOSAL_LINK_BASE_URL'],
        message: 'must be on the same origin as APP_ORIGIN (homeowners sign through it)',
      });
    }
    const googleAds = [
      'GOOGLE_ADS_DEVELOPER_TOKEN',
      'GOOGLE_ADS_MANAGER_ID',
      'GOOGLE_ADS_CLIENT_ID',
      'GOOGLE_ADS_CLIENT_SECRET',
      'GOOGLE_ADS_REFRESH_TOKEN',
    ] as const;
    if (googleAds.some((name) => cfg[name])) {
      for (const name of googleAds) {
        if (!cfg[name]) {
          ctx.addIssue({
            code: 'custom',
            path: [name],
            message: 'is required when the other GOOGLE_ADS settings are set',
          });
        }
      }
    }
    const meta = ['META_APP_ID', 'META_APP_SECRET', 'META_SYSTEM_USER_TOKEN', 'META_BUSINESS_ID'] as const;
    if (meta.some((name) => cfg[name])) {
      for (const name of meta) {
        if (!cfg[name]) {
          ctx.addIssue({ code: 'custom', path: [name], message: 'is required when the other META settings are set' });
        }
      }
    }
    if (cfg.NODE_ENV === 'production' && cfg.TRUST_PROXY === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['TRUST_PROXY'],
        message: 'is required in production: the number of proxies in front of the API (1 on Render)',
      });
    }
    if (cfg.FAKE_PROVIDERS && cfg.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['FAKE_PROVIDERS'],
        message: 'must not be set in production',
      });
    }
    if (cfg.RELAY_PUBLIC_URL && cfg.NODE_ENV === 'production' && !cfg.RELAY_PUBLIC_URL.startsWith('wss:')) {
      ctx.addIssue({ code: 'custom', path: ['RELAY_PUBLIC_URL'], message: 'must be a wss:// URL' });
    }
  })
  .transform(({ HOST, BILLING_PLANS_FILE, PROPOSAL_LINK_BASE_URL, STORM_MAIL_FROM, RELAY_PUBLIC_URL, RELAY_TOKEN_SECRET, ...cfg }) => ({
    ...cfg,
    STORM_MAIL_FROM: STORM_MAIL_FROM ?? `storms@${mailDomain(cfg)}`,
    PROPOSAL_LINK_BASE_URL: PROPOSAL_LINK_BASE_URL ?? cfg.APP_ORIGIN,
    // D1 Front Desk
    RELAY_PUBLIC_URL: (RELAY_PUBLIC_URL ?? `${cfg.PUBLIC_BASE_URL.replace(/^http/, 'ws')}/relay`).replace(/\/+$/, ''),
    RELAY_TOKEN_SECRET:
      RELAY_TOKEN_SECRET ??
      Buffer.from(hkdfSync('sha256', Buffer.from(cfg.ENCRYPTION_KEY, 'base64'), Buffer.alloc(0), 'relay', 32)).toString('base64'),
    HOST: HOST ?? (cfg.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
    // Outside production the example file is the default; in production without Stripe it stays unset.
    BILLING_PLANS_FILE:
      BILLING_PLANS_FILE ?? (cfg.NODE_ENV === 'production' ? undefined : path.resolve(REPO_ROOT, EXAMPLE_BILLING_PLANS)),
  }));

export type Config = z.infer<typeof ConfigSchema>;

/** A URL's origin, or null when it is not a URL. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The environment was unusable. The message names the variables, never their values. */
export class ConfigError extends Error {
  constructor(problems: string[]) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parses an environment (normally `process.env`) into a Config. Blank values count as unset, so a
 * bare `POSTMARK_TOKEN=` line in an env file is the same as leaving it out. Throws ConfigError.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const result = ConfigSchema.safeParse(present);
  if (result.success) return result.data;
  throw new ConfigError(result.error.issues.map((i) => `${i.path.join('.') || 'environment'}: ${i.message}`));
}
