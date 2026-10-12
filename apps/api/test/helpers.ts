import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, inject } from 'vitest';
import { createPools, type Pools } from '@roofline/db';
import { resetDb, seedTwoCompanies, type SeedUser, type SeededCompany } from '@roofline/db/testing';
import { FakeSmsAdapter } from '@roofline/send-gate';
import { type AppDeps, createApp } from '../src/app.ts';
import type { GoogleClaims, GoogleVerifier } from '../src/auth/google.ts';
import type { Clock } from '../src/clock.ts';
import type { Config } from '../src/config.ts';
import { AppError, MESSAGES } from '../src/errors.ts';
import { InlineJobs } from '../src/jobs/queue.ts';
import type { Mailer } from '../src/mailer.ts';
import { FakeAdImageRenderer } from '../src/providers/fakes/ad-image.ts';
import { FakeStaticMap } from '../src/providers/fakes/static-map.ts'; // G1 Task 7
import { FakeAdsGoogle } from '../src/providers/fakes/ads-google.ts';
import { FakeAdsMeta } from '../src/providers/fakes/ads-meta.ts';
import { FakeBroadcastMailer } from '../src/providers/fakes/broadcast.ts';
import { FakeBillingProvider } from '../src/providers/fakes/billing.ts';
import { FakeAerialMeasure } from '../src/providers/fakes/aerial.ts';
import { FakeCalendarApi } from '../src/providers/fakes/calendar.ts';
import { FakeExactReports } from '../src/providers/fakes/exact-reports.ts';
import { FakeFootprintSource } from '../src/providers/fakes/footprints.ts';
import { FakeGeocoder } from '../src/providers/fakes/geocoder.ts';
import { FakeCallControl } from '../src/providers/fakes/call-control.ts';
import { FakeLineLookup } from '../src/providers/fakes/line-lookup.ts';
import { ScriptedLlm } from '../src/providers/fakes/scripted-llm.ts';
import { RelaySessions } from '../src/front-desk/relay-sessions.ts';
import { MemoryObjectStore } from '../src/providers/fakes/object-store.ts';
import { FakeTextingRegistrar } from '../src/providers/fakes/registrar.ts';
import { InlineQueue } from '../src/tasks/queue.ts';
import type { CurrentWeather, HourlyForecast, WeatherSource } from '../src/weather/source.ts';

/**
 * The company details every sign-up needs (F3). Tests spread it into each sign-up body; the
 * phone and address are valid, so only the field a test is about is wrong.
 */
export const SIGNUP_COMPANY = { companyPhone: '(402) 555-0199', companyAddress: '1200 Farnam St, Omaha, NE 68102' };

/** A supertest agent: it keeps cookies between requests, like a browser tab. */
export type SuperAgent = ReturnType<typeof request.agent>;

/** A clock tests control. It starts at the real time and then only moves when told to. */
export class TestClock implements Clock {
  private current: Date;

  constructor(start: Date = new Date()) {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  set(d: Date): void {
    this.current = new Date(d);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export type SentMail = { to: string; subject: string; text: string };

/** A mailer that records what it was asked to send. */
export class FakeMailer implements Mailer {
  readonly sent: SentMail[] = [];

  async send(msg: SentMail): Promise<void> {
    this.sent.push({ ...msg });
  }
}

/**
 * A Google verifier that never leaves the process. Tests `register` a credential string with the
 * claims it should stand for; any other credential is refused like a bad Google token would be.
 */
export class FakeGoogleVerifier implements GoogleVerifier {
  private readonly known = new Map<string, GoogleClaims>();

  register(credential: string, claims: GoogleClaims): void {
    this.known.set(credential, { ...claims });
  }

  async verify(credential: string): Promise<GoogleClaims> {
    const claims = this.known.get(credential);
    if (!claims) throw new AppError(401, MESSAGES.googleFailed);
    return { ...claims };
  }
}

/** What `FakeWeatherSource` answers until a test sets something else. */
export const FAKE_WEATHER: CurrentWeather = {
  tempF: 64,
  summary: 'Mostly Sunny',
  icon: 'sun',
  isDaytime: true,
  updatedAt: '2026-10-12T14:00:00.000Z',
};

/** What `FakeWeatherSource.hourly` answers until a test sets something else: three hours, soonest first. */
export const FAKE_HOURLY: HourlyForecast[] = [
  { at: '2026-10-12T14:00:00.000Z', precipPct: 10, gustMph: 12 },
  { at: '2026-10-12T15:00:00.000Z', precipPct: 40, gustMph: 25 },
  { at: '2026-10-12T16:00:00.000Z', precipPct: 80, gustMph: null },
];

/**
 * A weather source that never leaves the process. It records every place it was asked about and
 * answers `value` (null: the service has nothing); if `failure` is set it throws that instead.
 * `hourly` works the same way: it records each call and answers the first `hours` entries of
 * `hourlyValue` (null: the service has nothing), and throws `failure` when it is set.
 */
export class FakeWeatherSource implements WeatherSource {
  readonly calls: { lat: number; lng: number }[] = [];
  readonly hourlyCalls: { lat: number; lng: number; hours: number }[] = [];
  value: CurrentWeather | null = FAKE_WEATHER;
  hourlyValue: HourlyForecast[] | null = FAKE_HOURLY;
  failure: unknown = undefined;

  async current(lat: number, lng: number): Promise<CurrentWeather | null> {
    this.calls.push({ lat, lng });
    if (this.failure !== undefined) throw this.failure;
    return this.value && { ...this.value };
  }

  async hourly(lat: number, lng: number, hours: number): Promise<HourlyForecast[] | null> {
    this.hourlyCalls.push({ lat, lng, hours });
    if (this.failure !== undefined) throw this.failure;
    return this.hourlyValue && this.hourlyValue.slice(0, hours).map((h) => ({ ...h }));
  }

  // Ruling DC: the daily forecast is not on the WeatherSource interface; tests get no forecast.
  async daily(): Promise<null> {
    return null;
  }
}

export type TestApp = {
  app: Express;
  deps: AppDeps;
  clock: TestClock;
  mailer: FakeMailer;
  google: FakeGoogleVerifier;
  /** The step queue: it records what was enqueued and runs nothing until `queue.drain(deps)`. */
  queue: InlineQueue;
  /** The SMS provider: it records every text it was asked to send, and `failNext(n)` makes sends fail. */
  sms: FakeSmsAdapter;
  /** The weather source: it records the places it was asked about and answers `weather.value`. */
  weather: FakeWeatherSource;
  /** Address lookup: it records each call and answers from a fixed table. */
  geocoder: FakeGeocoder;
  /** Calendar providers: one fake per provider, the same instances the app's deps hold. */
  calendars: { google: FakeCalendarApi; microsoft: FakeCalendarApi };
  /** Building footprints: it records each lookup and answers from a fixed table. */
  footprints: FakeFootprintSource;
  /** Aerial measurement: it records each request and answers what it was given. */
  aerial: FakeAerialMeasure;
  /** Exact reports: it records each price and order; `orderUncertainNext()` makes the next order uncertain. */
  exactReports: FakeExactReports;
  /** The object store for signed proposals, kept in memory. */
  objectStore: MemoryObjectStore;
  /** Google Ads: it records each campaign call and answers from memory. */
  adsGoogle: FakeAdsGoogle;
  /** Meta ads: it records each campaign call and answers from memory. */
  adsMeta: FakeAdsMeta;
  /** Broadcast email: it records every message it was asked to send. */
  broadcast: FakeBroadcastMailer;
  /** The ad image renderer: it answers a fixed image without drawing. */
  adImage: FakeAdImageRenderer;
  /** G1 Task 7: the claim packet's map picture: a tiny PNG, `absent = true` answers null. */
  staticMap: FakeStaticMap;
  /** Billing: it records each customer, checkout, and meter event. */
  billing: FakeBillingProvider;
  /** Texting registration: `failNext` makes the next registrar call fail. */
  registrar: FakeTextingRegistrar;
  /** Background jobs: it records every send, and `drain(deps)` runs what is pending. */
  jobs: InlineJobs;
  // D1 Front Desk
  llm: ScriptedLlm;
  callControl: FakeCallControl;
  lineLookup: FakeLineLookup;
  relaySessions: RelaySessions;
  /** What work outside a request (the runner) handed to `deps.logError`, in order. Nothing is printed. */
  logged: { err: unknown; where: string }[];
  seed: { a: SeededCompany; b: SeededCompany };
  /**
   * Waits until all work the app started after answering (queued emails, the reset-request
   * lookup) has finished, including work those tasks start. Await it before asserting on
   * `mailer.sent` after such a request.
   */
  settle(): Promise<void>;
  /** Ends this app's database pools now. Optional: they are also ended when the test file finishes. */
  close(): Promise<void>;
};

/** Not a secret: 32 bytes of 0x01, base64. */
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');

/** A complete Config for tests, built directly (it never reads the environment). */
export function testConfig(
  urls: { tenant: string; system: string },
  overrides: Partial<Config> = {},
): Config {
  return {
    NODE_ENV: 'test',
    APP_ORIGIN: 'https://app.roofline.test',
    DATABASE_URL_TENANT: urls.tenant,
    DATABASE_URL_SYSTEM: urls.system,
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    PUBLIC_BASE_URL: 'https://app.roofline.test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_roofline',
    BILLING_PLANS_FILE: fileURLToPath(new URL('../../../config/billing-plans.example.json', import.meta.url)),
    POLICY_PAGES_DOMAIN: 'roofline.test',
    // Not a real client id: the fake verifier never looks at it, but the route needs one to be set.
    GOOGLE_CLIENT_ID: 'roofline-test.apps.googleusercontent.com',
    TRUST_PROXY: 0,
    API_RATE_LIMIT_PER_MIN: 600,
    PORT: 0,
    HOST: '127.0.0.1',
    // D1 Front Desk (ANTHROPIC_API_KEY stays unset)
    FRONT_DESK_ROUTER_MODEL: 'claude-haiku-5-5',
    FRONT_DESK_ANSWER_MODEL: 'claude-opus-5-5',
    AGENT_DRAFT_MODEL: 'claude-opus-5-5',
    AGENT_EXTRACT_MODEL: 'claude-haiku-5-5',
    FRONT_DESK_OPUS_FAST: false,
    FRONT_DESK_MAX_CALLS: 40,
    RELAY_PUBLIC_URL: 'wss://app.roofline.test/relay',
    RELAY_TOKEN_SECRET: 'relay-test-secret-0123456789abcdef0123',
    // G1 Agents (no static map in tests)
    MAPTILER_SERVER_KEY: undefined,
    EAGLEVIEW_ENV: 'sandbox',
    EAGLEVIEW_PRODUCT_ID: 0,
    PROPOSAL_LINK_BASE_URL: 'https://app.roofline.test',
    FOOTPRINTS_BASE_URL: 'https://usbuildingdata.blob.core.windows.net/usbuildings-v2/',
    GOOGLE_ADS_API_VERSION: 'v21',
    META_GRAPH_VERSION: 'v24.0',
    POSTMARK_BROADCAST_STREAM: 'broadcast',
    STORM_MAIL_FROM: 'storms@roofline.test',
    HAIL_STALE_MINUTES: 90,
    ...overrides,
  };
}

// One pair of pools per test file (and per URL pair): makeTestApp runs in beforeEach, and a new
// pool pair per test would pile up idle connections until Postgres runs out of slots.
const openPools = new Map<string, Pools>();

afterAll(async () => {
  const all = [...openPools.values()];
  openPools.clear();
  await Promise.all(all.map((p) => p.end()));
});

function poolsFor(config: Config): { pools: Pools; key: string } {
  const key = `${config.DATABASE_URL_TENANT}\n${config.DATABASE_URL_SYSTEM}`;
  let pools = openPools.get(key);
  if (!pools) {
    pools = createPools({ tenant: config.DATABASE_URL_TENANT, system: config.DATABASE_URL_SYSTEM });
    openPools.set(key, pools);
  }
  return { pools, key };
}

/**
 * Builds the app against the shared test database: empties it, seeds Acme Roofing and Bolt Roofing
 * (four members each), and wires fakes for everything that would reach outside the process.
 */
export async function makeTestApp(overrides: Partial<Config> = {}): Promise<TestApp> {
  const urls = inject('dbUrls');
  await resetDb(urls.owner);
  const seed = await seedTwoCompanies(urls.owner);

  const config = testConfig(urls, overrides);
  const { pools, key } = poolsFor(config);
  const clock = new TestClock();
  const mailer = new FakeMailer();
  const google = new FakeGoogleVerifier();
  const queue = new InlineQueue();
  const sms = new FakeSmsAdapter();
  const weather = new FakeWeatherSource();
  const geocoder = new FakeGeocoder();
  const calendars = { google: new FakeCalendarApi('google'), microsoft: new FakeCalendarApi('microsoft') };
  const footprints = new FakeFootprintSource();
  const aerial = new FakeAerialMeasure();
  const exactReports = new FakeExactReports();
  const objectStore = new MemoryObjectStore();
  const adsGoogle = new FakeAdsGoogle();
  const adsMeta = new FakeAdsMeta();
  const broadcast = new FakeBroadcastMailer();
  const adImage = new FakeAdImageRenderer();
  const staticMap = new FakeStaticMap();
  const billing = new FakeBillingProvider();
  const registrar = new FakeTextingRegistrar();
  const jobs = new InlineJobs();
  const llm = new ScriptedLlm();
  const callControl = new FakeCallControl();
  const lineLookup = new FakeLineLookup();
  const relaySessions = new RelaySessions();
  const logged: { err: unknown; where: string }[] = [];
  const pending = new Set<Promise<void>>();
  const deps: AppDeps = {
    pools,
    config,
    mailer,
    clock,
    google,
    queue,
    sms,
    weather,
    geocoder,
    calendars,
    footprints,
    aerial,
    exactReports,
    objectStore,
    adsGoogle,
    adsMeta,
    broadcast,
    adImage,
    staticMap,
    billing,
    registrar,
    jobs,
    // D1 Front Desk
    llm,
    callControl,
    lineLookup,
    relaySessions,
    logError: (err, where) => logged.push({ err, where }),
    onBackgroundTask: (task) => {
      pending.add(task);
      void task.finally(() => pending.delete(task));
    },
  };
  const app = createApp(deps);

  return {
    app,
    deps,
    clock,
    mailer,
    google,
    queue,
    sms,
    weather,
    geocoder,
    calendars,
    footprints,
    aerial,
    exactReports,
    objectStore,
    adsGoogle,
    adsMeta,
    broadcast,
    adImage,
    staticMap,
    billing,
    registrar,
    jobs,
    llm,
    callControl,
    lineLookup,
    relaySessions,
    logged,
    seed,
    async settle() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
    async close() {
      if (openPools.get(key) === pools) {
        openPools.delete(key);
        await pools.end();
      }
    },
  };
}

/** Signs in through the real login route and returns an agent carrying the session cookie. */
export async function loginAs(app: Express, user: SeedUser): Promise<SuperAgent> {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email: user.email, password: user.password });
  if (res.status !== 200) {
    throw new Error(`loginAs(${user.email}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return agent;
}
