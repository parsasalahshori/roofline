import { createPools } from '@roofline/db';
import { createApp } from './app.ts';
import { systemClock } from './clock.ts';
import { ConfigError, loadConfig } from './config.ts';
import { ConsoleMailer, type Mailer, PostmarkMailer } from './mailer.ts';

/** Entry point: `npm start -w @roofline/api`. Reads the environment, opens the pools, listens. */

const SHUTDOWN_GRACE_MS = 10_000;

function load() {
  try {
    return loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

const config = load();
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

const app = createApp({ pools, config, mailer, clock: systemClock });

// Express 5 calls this once, with the error as its argument if listening failed (port in use).
const server = app.listen(config.PORT, config.HOST, (err?: Error) => {
  if (err) {
    console.error(`Could not listen on ${config.HOST}:${config.PORT}: ${err.message}`);
    process.exit(1);
  }
  console.log(`Roofline API listening on http://${config.HOST}:${config.PORT} (${config.NODE_ENV})`);
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down.`);
  const force = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS);
  force.unref();
  server.close(() => {
    pools.end().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error('Closing the database pools failed:', err);
        process.exit(1);
      },
    );
  });
  server.closeIdleConnections();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
