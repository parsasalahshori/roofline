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

/** An on/off switch from an env string: `1` or `true` is yes, `0` or `false` is no; unset stays unset. */
const flag = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(['1', 'true', '0', 'false'], { error: 'must be 1, true, 0 or false' }))
  .transform((v) => v === '1' || v === 'true')
  .optional();

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
    POSTMARK_TOKEN: z.string().optional(),
    /** The From header for outgoing email, for example `Roofline <hello@example.com>`. */
    MAIL_FROM: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),

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

    /** How many reverse-proxy hops to trust for `req.ip` (0 = none). */
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
    if (cfg.POSTMARK_TOKEN && !cfg.MAIL_FROM) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_FROM'],
        message: 'is required when POSTMARK_TOKEN is set (Postmark needs a verified From address)',
      });
    }
  })
  .transform(({ HOST, ...cfg }) => ({
    ...cfg,
    HOST: HOST ?? (cfg.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
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
