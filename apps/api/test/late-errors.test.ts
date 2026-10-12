import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { describeErrorForLog, errorHandler } from '../src/errors.ts';

/*
 * Security finding 12: an error raised after the headers went out (a CSV export that fails while it
 * streams) can't become a JSON 500. It must still be logged only through `logError` (the scrubbed
 * one line) and never reach Express's own logger, which prints the whole error and its `cause`
 * (Drizzle's query params, Postgres's detail). No database is needed.
 */

/** An error shaped like Drizzle's failed query: params in the message, the pg error in `cause`. */
function failedQuery(): Error {
  const pg = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    detail: 'Key (email)=(owner@a.test) already exists.',
  });
  return new Error('Failed query: select * from customers where email = $1\nparams: owner@a.test', { cause: pg });
}

function streamingApp(logError: (err: unknown, path: string) => void) {
  const app = express();
  app.get('/api/export/customers.csv', (_req, res, next) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.write('Name,Email\r\n');
    // The rows fail after the header row is out.
    setTimeout(() => next(failedQuery()), 5);
  });
  app.use(errorHandler(logError));
  // Express's default handler would run next; it must never see the error.
  app.set('env', 'production');
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('errors after the headers are sent', () => {
  test('are logged once, scrubbed, and the response is cut off', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logged: { err: unknown; path: string }[] = [];
    const app = streamingApp((err, path) => logged.push({ err, path }));

    const outcome = await request(app)
      .get('/api/export/customers.csv')
      .then(
        (res) => ({ status: res.status, text: res.text, failed: false }),
        () => ({ status: 0, text: '', failed: true }),
      );

    // The client never gets a complete download that looks fine: the connection is cut.
    expect(outcome.failed).toBe(true);

    expect(logged).toHaveLength(1);
    expect(logged[0]!.path).toBe('/api/export/customers.csv');
    const line = describeErrorForLog(logged[0]!.err);
    expect(line).toBe('Error: Failed query: select * from customers where email = $1 (pg 23505)');
    expect(line).not.toContain('owner@a.test');

    // Express's own logger (console.error with the raw error and its cause) never ran.
    const printed = consoleError.mock.calls.map((args) => args.map((a) => (a instanceof Error ? `${a.stack} ${String(a.cause)}` : String(a))).join(' ')).join('\n');
    expect(printed).not.toContain('params');
    expect(printed).not.toContain('owner@a.test');
    expect(consoleError).not.toHaveBeenCalled();
  });
});
