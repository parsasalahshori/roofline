import { Router, type Request, type Response } from 'express';
import {
  audit,
  CUSTOMER_EXPORT_HEADERS,
  customerExportRows,
  JOB_EXPORT_HEADERS,
  jobExportRows,
  textingCompanyFacts,
  type TenantContext,
  type Tx,
  withTenant,
} from '@roofline/db';
import { csvCell, localDate, toCsv } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { requireCapability } from '../permissions.ts';

type CsvValue = string | number | boolean | null;

/** One CSV download: what it is called, its header row, its rows, and the audit action it writes. */
type ExportSpec = {
  action: 'export.customers' | 'export.jobs';
  file: 'customers' | 'jobs';
  headers: readonly string[];
  rows: (tx: Tx, ctx: TenantContext) => AsyncGenerator<CsvValue[]>;
};

const CUSTOMERS: ExportSpec = {
  action: 'export.customers',
  file: 'customers',
  headers: CUSTOMER_EXPORT_HEADERS,
  rows: customerExportRows,
};

const JOBS: ExportSpec = {
  action: 'export.jobs',
  file: 'jobs',
  headers: JOB_EXPORT_HEADERS,
  rows: jobExportRows,
};

/** Resolves once the response can take more bytes, or once the client has gone away. */
function drained(res: Response): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

/**
 * Streams one export as CSV, inside a single tenant transaction. The first row is read, and the
 * audit row written, before any header or byte is sent, so a failure up to that point is an
 * ordinary error response and every download leaves an audit row even if the client drops early.
 * Rows are written with `csvCell` (formula-safe) and CRLF line endings, honouring backpressure.
 */
async function sendCsv(deps: AppDeps, req: Request, res: Response, spec: ExportSpec): Promise<void> {
  const { pools, clock } = deps;
  const { ctx } = req;
  const now = clock.now();

  await withTenant(pools, ctx, async (tx) => {
    const company = await textingCompanyFacts(tx, ctx);
    if (!company) throw new AppError(404, MESSAGES.notFound);

    const rows = spec.rows(tx, ctx);
    try {
      let next = await rows.next();

      await audit(tx, ctx, {
        action: spec.action,
        targetType: 'company',
        targetId: ctx.companyId,
        ip: req.ip ?? null,
        at: now,
      });

      res.status(200);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${spec.file}-${localDate(now, company.timezone)}.csv"`,
      );
      res.write(toCsv(spec.headers, []));

      while (!next.done && !res.destroyed) {
        const line = next.value.map((cell) => csvCell(cell)).join(',') + '\r\n';
        if (!res.write(line)) await drained(res);
        next = await rows.next();
      }
      res.end();
    } finally {
      await rows.return(undefined);
    }
  });
}

/**
 * `/api/export`: CSV downloads of the customer and job lists. Owners and office members only
 * (`view_money_totals`); a rep gets the usual 403. The downloads are GETs, so they also work in
 * read-only mode.
 * - `GET /customers.csv` and `GET /jobs.csv`, each `text/csv` with an `attachment` filename dated
 *   today in the company's zone.
 */
export function exportRoutes(deps: AppDeps): Router {
  const router = Router();

  router.get('/customers.csv', requireCapability('view_money_totals'), async (req, res) => {
    await sendCsv(deps, req, res, CUSTOMERS);
  });

  router.get('/jobs.csv', requireCapability('view_money_totals'), async (req, res) => {
    await sendCsv(deps, req, res, JOBS);
  });

  return router;
}
