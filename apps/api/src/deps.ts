import { createPools } from '@roofline/db';
import type { AppDeps } from './app.ts';
import { JoseGoogleVerifier } from './auth/google.ts';
import { systemClock } from './clock.ts';
import { type Config, ConfigError, loadConfig } from './config.ts';
import { logErrorToConsole } from './errors.ts';
import type { JobQueue } from './jobs/queue.ts';
import { ConsoleMailer, type Mailer, PostmarkMailer } from './mailer.ts';
import { createBillingProvider } from './providers/billing.ts';
import { createGeocoder } from './providers/geocoder.ts';
import { createRegistrar } from './providers/registrar.ts';
import { createSmsAdapter } from './providers/sms.ts';
import type { StepQueue } from './tasks/queue.ts';
import { NwsWeatherSource } from './weather/nws.ts';
import { NullWeatherSource } from './weather/source.ts';

/*
 * How a process (the API server, the worker) turns its environment into the app's deps. Both
 * build them here, so they always agree on the pools, the mailer, the clock and the logger; they
 * differ only in what they do with them.
 */

/**
 * `loadConfig(env)`, or, when the environment is unusable, the problems (names, never values) on
 * stderr and exit code 1. For process entry points.
 */
export function loadConfigOrExit(env: Record<string, string | undefined>): Config {
  try {
    return loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

/**
 * The real deps for `config`: both database pools, Postmark when it is configured (otherwise
 * email is logged, with a warning in production), Google sign-in, the system clock, the console
 * logger, the weather (the National Weather Service, introducing itself as `NWS_USER_AGENT` or else
 * `Roofline (<PUBLIC_BASE_URL>)`; `WEATHER_DISABLED` swaps in the source that never asks), and the
 * outside-service seams: address lookup (`createGeocoder`), billing (`createBillingProvider`),
 * texting registration (`createRegistrar`) and SMS (`createSmsAdapter`). Each seam is the fake when
 * `FAKE_PROVIDERS` is set, the real provider when its settings are present, and otherwise an
 * unconfigured one that refuses its calls; the send gate's registration rule still stops a text to
 * a company that is not registered. `queue` is where approved steps go and `jobs` is where
 * background jobs go (the server and the worker pass a `PgBossQueue` and a `PgBossJobs`). The
 * caller ends `deps.pools` when it shuts down.
 */
export function buildDeps(config: Config, queue: StepQueue, jobs: JobQueue): AppDeps {
  const pools = createPools({ tenant: config.DATABASE_URL_TENANT, system: config.DATABASE_URL_SYSTEM });

  let mailer: Mailer;
  if (config.POSTMARK_TOKEN && config.MAIL_FROM) {
    mailer = new PostmarkMailer({ token: config.POSTMARK_TOKEN, from: config.MAIL_FROM });
  } else {
    if (config.NODE_ENV === 'production') {
      console.warn('POSTMARK_TOKEN is not set: email will be logged, not sent.');
    }
    mailer = new ConsoleMailer(config.NODE_ENV !== 'production');
  }

  const google = new JoseGoogleVerifier(config.GOOGLE_CLIENT_ID);
  const weather = config.WEATHER_DISABLED
    ? new NullWeatherSource()
    : new NwsWeatherSource({ userAgent: config.NWS_USER_AGENT ?? `Roofline (${config.PUBLIC_BASE_URL})` });
  return {
    pools,
    config,
    mailer,
    clock: systemClock,
    google,
    queue,
    sms: createSmsAdapter(config),
    weather,
    logError: logErrorToConsole,
    geocoder: createGeocoder(config),
    billing: createBillingProvider(config),
    registrar: createRegistrar(config),
    jobs,
  };
}
