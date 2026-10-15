import { createPools } from '@roofline/db';
import type { AppDeps } from './app.ts';
import { JoseGoogleVerifier } from './auth/google.ts';
import { systemClock } from './clock.ts';
import { type Config, ConfigError, loadConfig } from './config.ts';
import { logErrorToConsole } from './errors.ts';
import type { JobQueue } from './jobs/queue.ts';
import { ConsoleMailer, type Mailer, PostmarkMailer } from './mailer.ts';
import { createBillingProvider } from './providers/billing.ts';
import { type AerialMeasure, AerialUnavailableError } from './providers/aerial.ts';
import { createCalendarApis } from './providers/calendar.ts';
import { eagleViewOrdersFor } from './providers/eagleview/orders.ts';
import { eagleViewPropertyDataFor } from './providers/eagleview/property-data.ts';
import { type ExactReports, ExactReportsUnavailableError } from './providers/exact-reports.ts';
import { FakeAerialMeasure } from './providers/fakes/aerial.ts';
import { DemoExactReports } from './providers/fakes/demo-exact-reports.ts';
import { FakeExactReports } from './providers/fakes/exact-reports.ts';
import type { AdsGoogle } from './providers/ads-google.ts';
import type { AdsMeta } from './providers/ads-meta.ts';
import type { BroadcastMailer } from './providers/broadcast.ts';
import { FakeAdImageRenderer } from './providers/fakes/ad-image.ts';
import { FakeAdsGoogle } from './providers/fakes/ads-google.ts';
import { FakeAdsMeta } from './providers/fakes/ads-meta.ts';
import { FakeBroadcastMailer } from './providers/fakes/broadcast.ts';
import { googleAdsFor } from './providers/google-ads/index.ts';
import { metaAdsFor } from './providers/meta/index.ts';
import { postmarkBroadcastFor } from './providers/postmark-broadcast.ts';
import { resvgCardFor } from './providers/resvg-card.ts';
import { createStaticMap } from './providers/static-map.ts'; // G1 Task 7
import { createStreetView } from './providers/street-view.ts';
import { createWindowDetector } from './providers/window-detector.ts';
import { createFootprintSource } from './providers/footprints.ts';
import { createObjectStore } from './providers/object-store.ts';
import { createGeocoder } from './providers/geocoder.ts';
import { createSolarApi } from './providers/solar.ts';
import { createSolarLayersApi } from './providers/solar-layers.ts';
import { createUsgsLidarService } from './providers/usgs-lidar-service.ts';
import type { CallControl } from './providers/call-control.ts';
import type { LineLookup } from './providers/line-lookup.ts';
import { type Llm, LlmUnavailableError } from './providers/llm.ts';
import { anthropicFor } from './providers/anthropic/index.ts';
import { FakeCallControl } from './providers/fakes/call-control.ts';
import { FakeLineLookup } from './providers/fakes/line-lookup.ts';
import { ScriptedLlm } from './providers/fakes/scripted-llm.ts';
import { demoLlm } from './demo/script.ts';
import { twilioLookupFor } from './providers/twilio/lookup.ts';
import { twilioCallControlFor } from './providers/twilio/voice.ts';
import { RelaySessions } from './front-desk/relay-sessions.ts';
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

/** Aerial measurement when EagleView is not set up: it says so on every call. */
export class UnconfiguredAerial implements AerialMeasure {
  readonly configured = false;
  async start(): Promise<{ requestId: string }> {
    throw new AerialUnavailableError("Aerial measurement isn't set up.");
  }
  async result(): Promise<never> {
    throw new AerialUnavailableError("Aerial measurement isn't set up.");
  }
}

/** Exact reports when EagleView is not set up: it says so on every call. */
export class UnconfiguredExactReports implements ExactReports {
  readonly configured = false;
  async price(): Promise<never> {
    throw new ExactReportsUnavailableError("Exact reports aren't set up.");
  }
  async order(): Promise<never> {
    throw new ExactReportsUnavailableError("Exact reports aren't set up.");
  }
  async report(): Promise<never> {
    throw new ExactReportsUnavailableError("Exact reports aren't set up.");
  }
}

/** Google Ads when it is not set up: it says so on every call. */
export class UnconfiguredAdsGoogle implements AdsGoogle {
  readonly configured = false;
  managerId = '';
  async invite(): Promise<never> {
    throw new Error("Google Ads isn't set up.");
  }
  async unlink(): Promise<never> {
    throw new Error("Google Ads isn't set up.");
  }
  async linkStatus(): Promise<never> {
    throw new Error("Google Ads isn't set up.");
  }
  async accountInfo(): Promise<never> {
    throw new Error("Google Ads isn't set up.");
  }
  async findCampaign(): Promise<never> {
    throw new Error("Google Ads isn't set up.");
  }
  async createCampaign(): Promise<never> {
    throw new Error("Google Ads isn't set up.");
  }
  async setStatus(): Promise<never> {
    throw new Error("Google Ads isn't set up.");
  }
  async stats(): Promise<never> {
    throw new Error("Google Ads isn't set up.");
  }
}

/** Meta ads when they are not set up: it says so on every call. */
export class UnconfiguredAdsMeta implements AdsMeta {
  readonly configured = false;
  businessId = '';
  async verifyAccess(): Promise<never> {
    throw new Error("Meta ads aren't set up.");
  }
  async findCampaign(): Promise<never> {
    throw new Error("Meta ads aren't set up.");
  }
  async createCampaign(): Promise<never> {
    throw new Error("Meta ads aren't set up.");
  }
  async setStatus(): Promise<never> {
    throw new Error("Meta ads aren't set up.");
  }
  async stats(): Promise<never> {
    throw new Error("Meta ads aren't set up.");
  }
}

/** Broadcast email when Postmark is not set up: it says so on every send. */
export class UnconfiguredBroadcastMailer implements BroadcastMailer {
  readonly configured = false;
  async send(): Promise<never> {
    throw new Error("Broadcast email isn't set up.");
  }
}

function adsGoogleFor(config: Config): AdsGoogle {
  if (config.FAKE_PROVIDERS) return new FakeAdsGoogle();
  return googleAdsFor(config) ?? new UnconfiguredAdsGoogle();
}

function adsMetaFor(config: Config): AdsMeta {
  if (config.FAKE_PROVIDERS) return new FakeAdsMeta();
  return metaAdsFor(config) ?? new UnconfiguredAdsMeta();
}

function broadcastFor(config: Config): BroadcastMailer {
  if (config.FAKE_PROVIDERS) return new FakeBroadcastMailer();
  return postmarkBroadcastFor(config) ?? new UnconfiguredBroadcastMailer();
}

function aerialFor(config: Config): AerialMeasure {
  if (config.FAKE_PROVIDERS) return new FakeAerialMeasure();
  return eagleViewPropertyDataFor(config) ?? new UnconfiguredAerial();
}

function exactReportsFor(config: Config): ExactReports {
  if (config.DEMO_MODE) return new DemoExactReports();
  if (config.FAKE_PROVIDERS) return new FakeExactReports();
  return eagleViewOrdersFor(config) ?? new UnconfiguredExactReports();
}

/** The Llm when no key is set: every call says Front Desk is not set up. */
export class UnconfiguredLlm implements Llm {
  readonly configured = false;
  private fail(): never {
    throw new LlmUnavailableError('Front Desk is not set up: ANTHROPIC_API_KEY is missing.');
  }
  route(): never {
    return this.fail();
  }
  answer(): never {
    return this.fail();
  }
  summarize(): never {
    return this.fail();
  }
  // G1 Agents
  draftTexts(): never {
    return this.fail();
  }
  extractClaimReply(): never {
    return this.fail();
  }
}

/** Call control that refuses every call (Twilio voice is not configured). */
export class UnconfiguredCallControl implements CallControl {
  readonly configured = false;
  private refuse(): Promise<never> {
    return Promise.reject(new Error('Call control is not configured.'));
  }
  startRecording(): Promise<never> {
    return this.refuse();
  }
  stopRecording(): Promise<never> {
    return this.refuse();
  }
  fetchRecording(): Promise<never> {
    return this.refuse();
  }
  deleteRecording(): Promise<never> {
    return this.refuse();
  }
  placeTestCall(): Promise<never> {
    return this.refuse();
  }
  setVoiceUrl(): Promise<never> {
    return this.refuse();
  }
}

/** The fake Llm with FAKE_PROVIDERS, the real one when a key is set, else one that refuses. Never builds a client here. */
export function createLlm(config: Config): Llm {
  // Demo mode: the scripted Front Desk answers believable lines (demo/script.ts) instead of "say that again".
  if (config.DEMO_MODE) return demoLlm();
  return config.FAKE_PROVIDERS ? new ScriptedLlm() : (anthropicFor(config) ?? new UnconfiguredLlm());
}

export function createCallControl(config: Config): CallControl {
  return config.FAKE_PROVIDERS ? new FakeCallControl() : (twilioCallControlFor(config) ?? new UnconfiguredCallControl());
}

export function createLineLookup(config: Config): LineLookup {
  return config.FAKE_PROVIDERS
    ? new FakeLineLookup()
    : (twilioLookupFor(config) ?? { lineType: async () => 'unknown' as const });
}

/**
 * The real deps for `config`: both database pools, Postmark when it is configured (otherwise
 * email is logged, with a warning in production), Google sign-in, the system clock, the console
 * logger, the weather (the National Weather Service, introducing itself as `NWS_USER_AGENT` or else
 * `Roofline (<PUBLIC_BASE_URL>)`; `WEATHER_DISABLED` swaps in the source that never asks), and the
 * outside-service seams: address lookup (`createGeocoder`), billing (`createBillingProvider`),
 * texting registration (`createRegistrar`), SMS (`createSmsAdapter`) and calendars
 * (`createCalendarApis`, one per provider), and the estimator's four: building footprints
 * (`createFootprintSource`), aerial measurement (EagleView property data), exact reports (EagleView
 * orders) and the object store for signed proposals (`createObjectStore`, R2), and the storm four:
 * Google Ads (`adsGoogle`), Meta ads (`adsMeta`), broadcast email on Postmark's broadcast stream
 * (`broadcast`) and the ad image renderer (`adImage`, resvg). Each seam is the fake when
 * `FAKE_PROVIDERS` is set, the real provider when its settings are present, and otherwise an
 * unconfigured one that refuses its calls; the send gate's registration rule still stops a text to
 * a company that is not registered. `queue` is where approved steps go and `jobs` is where
 * background jobs go (the server and the worker pass a `PgBossQueue` and a `PgBossJobs`). The
 * caller ends `deps.pools` when it shuts down.
 */
export function buildDeps(config: Config, queue: StepQueue, jobs: JobQueue): AppDeps {
  const pools = createPools({ tenant: config.DATABASE_URL_TENANT, system: config.DATABASE_URL_SYSTEM });

  let mailer: Mailer;
  if (config.POSTMARK_TOKEN && config.MAIL_FROM && !config.DEMO_MODE) {
    mailer = new PostmarkMailer({ token: config.POSTMARK_TOKEN, from: config.MAIL_FROM });
  } else {
    if (config.NODE_ENV === 'production') {
      console.warn('POSTMARK_TOKEN is not set: email will be logged, not sent.');
    }
    mailer = new ConsoleMailer(config.NODE_ENV !== 'production');
  }

  if (config.DEMO_MODE) {
    console.warn('DEMO_MODE is on: every outside service is a fake; no text, email, call or charge leaves this process.');
  } else if (config.NODE_ENV === 'production' && !config.ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY is not set: Front Desk is off.');
  }

  const google = new JoseGoogleVerifier(config.GOOGLE_CLIENT_ID);
  const weather = config.WEATHER_DISABLED
    ? new NullWeatherSource()
    : new NwsWeatherSource({ userAgent: config.NWS_USER_AGENT ?? `Roofline (${config.PUBLIC_BASE_URL})` });
  const objectStore = createObjectStore(config, pools);
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
    calendars: createCalendarApis(config),
    footprints: createFootprintSource(config),
    solar: createSolarApi(config),
    solarLayers: createSolarLayersApi(config),
    aerial: aerialFor(config),
    exactReports: exactReportsFor(config),
    objectStore,
    usgsLidar: createUsgsLidarService(config, objectStore, systemClock),
    adsGoogle: adsGoogleFor(config),
    adsMeta: adsMetaFor(config),
    broadcast: broadcastFor(config),
    adImage: config.FAKE_PROVIDERS ? new FakeAdImageRenderer() : resvgCardFor(config),
    staticMap: createStaticMap(config), // G1 Task 7
    streetView: createStreetView(config),
    windowDetector: createWindowDetector(config),
    jobs,
    // D1 Front Desk
    llm: createLlm(config),
    callControl: createCallControl(config),
    lineLookup: createLineLookup(config),
    relaySessions: new RelaySessions(),
  };
}
