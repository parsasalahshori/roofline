import type { Express } from 'express';
import request from 'supertest';
import { afterAll, inject } from 'vitest';
import { createPools, type Pools } from '@roofline/db';
import { resetDb, seedTwoCompanies, type SeedUser, type SeededCompany } from '@roofline/db/testing';
import { type AppDeps, createApp } from '../src/app.ts';
import type { GoogleClaims, GoogleVerifier } from '../src/auth/google.ts';
import type { Clock } from '../src/clock.ts';
import type { Config } from '../src/config.ts';
import { AppError, MESSAGES } from '../src/errors.ts';
import type { Mailer } from '../src/mailer.ts';

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

export type TestApp = {
  app: Express;
  deps: AppDeps;
  clock: TestClock;
  mailer: FakeMailer;
  google: FakeGoogleVerifier;
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
    // Not a real client id: the fake verifier never looks at it, but the route needs one to be set.
    GOOGLE_CLIENT_ID: 'roofline-test.apps.googleusercontent.com',
    TRUST_PROXY: 0,
    API_RATE_LIMIT_PER_MIN: 600,
    PORT: 0,
    HOST: '127.0.0.1',
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
 * Later tasks add the step queue and SMS adapter fakes here.
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
  const pending = new Set<Promise<void>>();
  const deps: AppDeps = {
    pools,
    config,
    mailer,
    clock,
    google,
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
