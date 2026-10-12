import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import type { Pools } from '@roofline/db';
import type { SmsAdapter } from '@roofline/send-gate';
import type { Clock } from './clock.ts';
import type { Config } from './config.ts';
import type { GoogleVerifier } from './auth/google.ts';
import { attachSession, requireSession } from './auth/middleware.ts';
import { meRoutes } from './auth/me.ts';
import { authRoutes } from './auth/routes.ts';
import { billingRoutes } from './account/billing-routes.ts';
import { setupRoutes } from './account/setup-routes.ts';
import { textingRoutes } from './account/texting-routes.ts';
import { errorHandler, logErrorToConsole, MESSAGES, notFoundHandler } from './errors.ts';
import { stripeHooks } from './hooks/stripe.ts';
import { twilioHooks } from './hooks/twilio.ts';
import { twilioRegistrationHooks } from './hooks/twilio-registration.ts';
import type { JobQueue } from './jobs/queue.ts';
import { readOnlyGuard } from './billing/read-only.ts';
import type { Mailer } from './mailer.ts';
import type { CalendarApis } from './providers/calendar.ts';
import type { BillingProvider } from './providers/billing.ts';
import type { Geocoder } from './providers/geocoder.ts';
import type { TextingRegistrar } from './providers/registrar.ts';
import { apiRateLimit } from './rate-limit.ts';
import { activityRoutes } from './routes/activities.ts';
import { appointmentRoutes } from './routes/appointments.ts';
import { approvalRoutes } from './routes/approvals.ts';
import { calendarConnectRoutes } from './routes/calendar-connect.ts';
import { calendarRoutes } from './routes/calendar.ts';
import { companyRoutes } from './routes/company.ts';
import { customerRoutes } from './routes/customers.ts';
import { exportRoutes } from './routes/export.ts';
import { importRoutes } from './routes/imports.ts';
import { jobRoutes } from './routes/jobs.ts';
import { mapRoutes } from './routes/map.ts';
import { noteRoutes } from './routes/notes.ts';
import { pricebookRoutes } from './routes/pricebook.ts';
import { propertyRoutes } from './routes/properties.ts';
import { jobQuoteRoutes, quoteRoutes } from './routes/quotes.ts';
import { searchRoutes } from './routes/search.ts';
import { taskRoutes } from './routes/tasks.ts';
import { teamRoutes } from './routes/team.ts';
import { timelineRoutes } from './routes/timeline.ts';
import { todayRoutes } from './routes/today.ts';
import { weatherRoutes } from './routes/weather.ts';
import type { StepQueue } from './tasks/queue.ts';
import { policyPages } from './public/policies.ts';
import { serveWeb } from './web.ts';
import type { WeatherSource } from './weather/source.ts';

/** Everything the app reaches outside itself through. Tests pass fakes for all of it. */
export type AppDeps = {
  pools: Pools;
  config: Config;
  mailer: Mailer;
  clock: Clock;
  /** Checks the credential Google's sign-in button produces. Tests pass a fake that maps strings to claims. */
  google: GoogleVerifier;
  /**
   * Where approved steps go to be run (tasks/queue.ts). Given step ids only after the approval has
   * committed. Tests pass an `InlineQueue` and drain it themselves.
   */
  queue: StepQueue;
  /**
   * The SMS provider every outbound text goes through, after the send gate said yes. The server
   * and the worker use `DisabledSmsAdapter` until F3 adds Twilio; tests pass a `FakeSmsAdapter`.
   */
  sms: SmsAdapter;
  /**
   * Where the weather chip's numbers come from (weather/source.ts). The server uses the National
   * Weather Service, or `NullWeatherSource` when `WEATHER_DISABLED` is set; tests pass a fake, so
   * no test reaches the network.
   */
  weather: WeatherSource;
  /**
   * Where work that runs outside a request reports an error worth a person's look (the runner, when
   * a step gives up after its last attempt). It gets the error itself and where it happened, and
   * must print no more than `describeErrorForLog(err)` does. Defaults to `logErrorToConsole`.
   * Requests answered with a 500 go to `AppOptions.logError` instead.
   */
  logError?: (err: unknown, where: string) => void;
  /**
   * Called with the promise of every piece of work the app starts after it has already answered
   * (the emails behind reset-request, for example). The promise never rejects: failures are logged.
   * The server leaves this unset; tests collect the promises and await them instead of sleeping.
   */
  onBackgroundTask?: (task: Promise<void>) => void;
  /**
   * Where address lookups come from (providers/geocoder.ts). The server uses Geocodio, or an
   * unconfigured geocoder that fails each lookup with a setup message; tests pass `FakeGeocoder`.
   */
  geocoder: Geocoder;
  /** The calendar provider seam (providers/calendar.ts): one api per provider; tests pass fakes. */
  calendars: CalendarApis;
  /**
   * Where billing goes (providers/billing.ts): Stripe when configured, else an unconfigured
   * provider; tests pass `FakeBillingProvider`.
   */
  billing: BillingProvider;
  /**
   * Where texting registration goes (providers/registrar.ts): Twilio's subaccounts, brands and
   * campaigns when configured, else an unconfigured registrar; tests pass `FakeTextingRegistrar`.
   */
  registrar: TextingRegistrar;
  /**
   * Where the app sends work that runs in the worker's job queues (jobs/queue.ts): pg-boss in the
   * server and the worker, or `InlineJobs` in tests, which drain it themselves.
   */
  jobs: JobQueue;
};

export type AppOptions = {
  /**
   * Mounts extra routes after the body parser and before the /api sign-in gate and the 404. For
   * tests: routes mounted here need no session and are not rate limited.
   */
  extraRoutes?: (app: Express) => void;
  /**
   * Called with every unexpected error (the ones answered with a 500). Defaults to console.error
   * of `describeErrorForLog`, which never prints SQL parameters.
   */
  logError?: (err: unknown, path: string) => void;
};

/** JSON bodies are capped at 256 KB. */
export const JSON_BODY_LIMIT = '256kb';

/**
 * `/api/approvals` takes up to 1 MB: a text batch for 5,000 customers is about 200 KB of ids and
 * the screen sends it back whole on an edit, so a bigger plan must not meet the 256 KB cap. It is
 * The global parser skips /api/approvals. This parser is mounted after the sign-in gate, so a
 * signed-out request gets its 401 before any body is read.
 */
export const APPROVALS_JSON_BODY_LIMIT = '1mb';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Where the map's tiles, glyphs and sprites come from (MapTiler, or OpenStreetMap's own tile server). */
const MAP_HOSTS = ['https://api.maptiler.com', 'https://tile.openstreetmap.org'] as const;

/**
 * The Content-Security-Policy for the web app, which the API serves (web.ts) and whose JSON
 * answers carry it too, harmlessly. Everything is the app's own origin except the map: its tiles
 * and style come from MAP_HOSTS, and MapLibre runs its tile workers from blob: URLs. Inline styles
 * are allowed because the map and the UI set `style` attributes; inline and remote scripts are not.
 * `upgrade-insecure-requests` is production only, since the end-to-end stack is plain http on
 * 127.0.0.1 and would have its own scripts upgraded to https and broken.
 */
function contentSecurityPolicy(nodeEnv: Config['NODE_ENV']) {
  return {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://accounts.google.com/gsi/client'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com/gsi/style'],
      imgSrc: ["'self'", 'data:', 'blob:', ...MAP_HOSTS],
      connectSrc: ["'self'", ...MAP_HOSTS, 'https://accounts.google.com/gsi/'],
      fontSrc: ["'self'", 'data:'],
      workerSrc: ["'self'", 'blob:'],
      childSrc: ['blob:'],
      // Google sign-in loads its script, frame, styles and calls from accounts.google.com/gsi.
      frameSrc: ['https://accounts.google.com/gsi/'],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: nodeEnv === 'production' ? [] : null,
    },
  };
}

/**
 * A browser that sends an Origin header on a mutation is telling us which site the request came
 * from. Anything other than the web app's own origin is refused. Requests with no Origin (scripts,
 * Twilio's webhooks) are not browser cross-site requests and pass; the session cookie is
 * SameSite=Lax as well.
 */
function blockCrossSiteMutations(appOrigin: string): RequestHandler {
  return (req, res, next) => {
    const origin = req.get('Origin');
    if (origin !== undefined && !SAFE_METHODS.has(req.method) && origin !== appOrigin) {
      res.status(403).json({ error: MESSAGES.crossSite });
      return;
    }
    next();
  };
}

export function createApp(deps: AppDeps, options: AppOptions = {}): Express {
  const { config } = deps;
  const app = express();

  app.set('trust proxy', config.TRUST_PROXY);
  app.use(helmet({ contentSecurityPolicy: contentSecurityPolicy(config.NODE_ENV) }));
  // The public policy pages (privacy and terms): no session, no rate limit, served before /health.
  app.use(policyPages(deps));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(blockCrossSiteMutations(config.APP_ORIGIN));
  // Twilio's webhooks (hooks/twilio.ts): signed form posts, no session, no rate limit. Mounted
  // ahead of the JSON parser and the /api gate, with its own form parser (64 KB), so these routes
  // only ever read form bodies.
  app.use('/hooks/twilio', twilioHooks(deps));
  // Stripe's webhooks read the raw body (stripeHooks sets its own parser). The Twilio registration
  // callbacks are signed form posts too, like /hooks/twilio.
  app.use('/hooks/stripe', stripeHooks(deps));
  app.use('/hooks/twilio-registration', twilioRegistrationHooks(deps));
  // JSON only. `express.urlencoded` is deliberately not mounted here: Twilio's webhooks are the
  // one form-encoded caller, and /hooks/twilio/* adds it for itself.
  const globalJson = express.json({ limit: JSON_BODY_LIMIT });
  // /api/approvals is left unparsed here: it gets its own 1 MB parser after the sign-in gate below.
  app.use((req, res, next) => {
    if (/^\/api\/approvals(?:\/|$)/i.test(req.path)) {
      next();
      return;
    }
    globalJson(req, res, next);
  });

  options.extraRoutes?.(app);

  // Everything under /api: find the session, rate limit (per session, else per IP), then refuse
  // anyone who is not signed in. The public auth routes are the only exceptions (middleware.ts).
  // /health and /hooks/* are not under /api, so they are never limited.
  const logError = options.logError ?? logErrorToConsole;
  app.use('/api', attachSession(deps), apiRateLimit(config), requireSession);
  // Refuses writes from a company whose billing has lapsed (billing/read-only.ts).
  app.use('/api', readOnlyGuard);
  // Signed-in requests only: a signed-out one was already refused above, before any body was read.
  app.use('/api/approvals', express.json({ limit: APPROVALS_JSON_BODY_LIMIT }));

  // Routers are mounted here as later tasks add them.
  app.use('/api/auth', authRoutes(deps, logError));
  app.use('/api/me', meRoutes(deps));
  app.use('/api/company', companyRoutes(deps));
  app.use('/api/team', teamRoutes(deps, logError));
  app.use('/api/customers', customerRoutes(deps));
  app.use('/api/properties', propertyRoutes(deps));
  // Before /api/jobs: Express matches in order, and jobRoutes would otherwise take /:id/quotes.
  app.use('/api/jobs/:jobId/quotes', jobQuoteRoutes(deps));
  app.use('/api/jobs', jobRoutes(deps));
  app.use('/api/activities', activityRoutes(deps));
  app.use('/api/approvals', approvalRoutes(deps, logError));
  app.use('/api/tasks', taskRoutes(deps));
  app.use('/api/search', searchRoutes(deps));
  app.use('/api/map', mapRoutes(deps));
  app.use('/api/weather', weatherRoutes(deps));
  app.use('/api/appointments', appointmentRoutes(deps));
  app.use('/api/today', todayRoutes(deps));
  app.use('/api/calendar', calendarRoutes(deps));
  app.use('/api/calendar', calendarConnectRoutes(deps));
  app.use('/api/timeline', timelineRoutes(deps));
  app.use('/api/notes', noteRoutes(deps));
  app.use('/api/pricebook', pricebookRoutes(deps));
  app.use('/api/quotes', quoteRoutes(deps));
  app.use('/api/export', exportRoutes(deps));
  app.use('/api/billing', billingRoutes(deps));
  app.use('/api/setup', setupRoutes(deps));
  app.use('/api/imports', importRoutes(deps));
  app.use('/api/texting', textingRoutes(deps));

  // The web app itself, when there is a build to serve. After every API route, so it can only
  // answer what they did not; web.ts keeps it off /api, /hooks and /health.
  if (config.WEB_DIST_DIR !== undefined) serveWeb(app, config.WEB_DIST_DIR);

  app.use(notFoundHandler);
  app.use(errorHandler(logError));
  return app;
}
