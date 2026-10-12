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

/** A bare hostname (lowercase, checked after folding case): `roofline.app`, `policies.example.co`. */
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/** The example plans file, shipped with the repository; the default outside production. */
const EXAMPLE_BILLING_PLANS = 'config/billing-plans.example.json';

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
  })
  .transform(({ HOST, BILLING_PLANS_FILE, ...cfg }) => ({
    ...cfg,
    HOST: HOST ?? (cfg.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
    // Outside production the example file is the default; in production without Stripe it stays unset.
    BILLING_PLANS_FILE:
      BILLING_PLANS_FILE ?? (cfg.NODE_ENV === 'production' ? undefined : path.resolve(REPO_ROOT, EXAMPLE_BILLING_PLANS)),
  }));

export type Config = z.infer<typeof ConfigSchema>;

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
