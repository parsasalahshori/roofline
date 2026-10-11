import express, { type ErrorRequestHandler, Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  audit,
  companies,
  createImport,
  getImport,
  type ImportRow,
  insertImportRows,
  listImports,
  retryImport,
  setImportMapping,
  skippedImportRows,
  startImport,
  type TenantContext,
  type Tx,
  withTenant,
} from '@roofline/db';
import { consentAttestationText, IMPORT_FIELDS, type ImportField, type ImportMapping, type ImportView } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { autoMap } from '../imports/mapping.ts';
import { ImportFileError, parseUpload } from '../imports/parse.ts';
import { buildImportView } from '../imports/preview.ts';
import { skippedCsv } from '../imports/skipped-csv.ts';
import { requireCapability } from '../permissions.ts';
import { parse, UUID } from '../validate.ts';

const UPLOAD_LIMIT = '10mb';
const TOO_BIG_MESSAGE = 'That file is too big. The most we can take is 10 MB.';
const FILE_MESSAGE = 'Please upload a .csv or .xlsx file.';
const MAPPING_MESSAGE = 'Match each column once.';
const ALREADY_STARTED = 'This import already started.';
const NAME_MESSAGE = 'Match a column to Name.';
const CONTACT_MESSAGE = 'Match a column to Phone or Email.';
const CONSENT_MESSAGE = 'Please confirm the consent statement as shown.';
const NOT_FAILED = 'Only a failed import can be tried again.';
const NOT_FINISHED = "This import isn't finished yet.";
const RECENT_LIMIT = 10;

const StartBody = z.object({
  consentAttested: z.boolean({ error: MESSAGES.checkField }),
  consentText: z.string({ error: CONSENT_MESSAGE }).nullish(),
});

/** Reads `{ mapping }` from a PATCH body: each key a known field, each value a distinct column index. */
function checkMapping(input: unknown, headerCount: number): ImportMapping {
  const bad = () => new AppError(400, MAPPING_MESSAGE, 'mapping');
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw bad();
  const fields: readonly string[] = IMPORT_FIELDS;
  const mapping: ImportMapping = {};
  for (const [key, value] of Object.entries(input)) {
    if (!fields.includes(key)) throw bad();
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= headerCount) throw bad();
    mapping[key as ImportField] = value;
  }
  const columns = Object.values(mapping);
  if (new Set(columns).size !== columns.length) throw bad();
  return mapping;
}

/**
 * `/api/imports`: the customer import. Every route needs the `import` capability (owner only), and
 * every read and write goes through the tenant repos inside `withTenant`. A job is sent only after
 * the transaction that starts the import has committed.
 */
export function importRoutes(deps: AppDeps): Router {
  const { pools, clock, jobs } = deps;
  const router = Router();

  const loadImport = async (tx: Tx, ctx: TenantContext, id: string): Promise<ImportRow> => {
    if (!UUID.test(id)) throw new AppError(404, MESSAGES.notFound);
    const row = await getImport(tx, ctx, id);
    if (!row) throw new AppError(404, MESSAGES.notFound);
    return row;
  };

  const sendJob = (companyId: string, importId: string) =>
    jobs.send('import-customers', { companyId, importId }, { singletonKey: importId });

  router.post(
    '/',
    requireCapability('import'),
    express.raw({ type: () => true, limit: UPLOAD_LIMIT }),
    async (req, res) => {
      const { ctx } = req;
      const fileName = typeof req.query.fileName === 'string' ? req.query.fileName.trim() : '';
      if (fileName === '') throw new AppError(400, FILE_MESSAGE, 'file');
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      let parsed: Awaited<ReturnType<typeof parseUpload>>;
      try {
        parsed = await parseUpload(bytes, fileName);
      } catch (err) {
        if (err instanceof ImportFileError) throw new AppError(400, err.message, 'file');
        throw err;
      }

      const now = clock.now();
      const view = await withTenant(pools, ctx, async (tx) => {
        const row = await createImport(
          tx,
          ctx,
          { fileName, headers: parsed.headers, mapping: autoMap(parsed.headers), rowCount: parsed.rows.length },
          now,
        );
        await insertImportRows(tx, ctx, row.id, parsed.rows);
        return buildImportView(tx, ctx, row, false);
      });
      res.status(201).json(view);
    },
  );

  // A file over the limit is refused by express.raw before this router reads it.
  const uploadErrors: ErrorRequestHandler = (err, _req, res, next) => {
    if ((err as { type?: unknown } | null)?.type === 'entity.too.large') {
      res.status(413).json({ error: TOO_BIG_MESSAGE });
      return;
    }
    next(err);
  };
  router.use(uploadErrors);

  router.get('/', requireCapability('import'), async (req, res) => {
    const { ctx } = req;
    const imports = await withTenant(pools, ctx, async (tx) => {
      const rows = await listImports(tx, ctx, RECENT_LIMIT);
      const views: ImportView[] = [];
      for (const row of rows) {
        views.push({ ...(await buildImportView(tx, ctx, row, false)), preview: [] });
      }
      return views;
    });
    res.json({ imports });
  });

  router.get('/:id', requireCapability('import'), async (req, res) => {
    const { ctx } = req;
    const id = req.params.id as string;
    const attested = req.query.attested === 'true';
    const view = await withTenant(pools, ctx, async (tx) =>
      buildImportView(tx, ctx, await loadImport(tx, ctx, id), attested),
    );
    res.json(view);
  });

  router.patch('/:id', requireCapability('import'), async (req, res) => {
    const { ctx } = req;
    const id = req.params.id as string;
    const now = clock.now();
    const view = await withTenant(pools, ctx, async (tx) => {
      const row = await loadImport(tx, ctx, id);
      const input = typeof req.body === 'object' && req.body !== null ? (req.body as { mapping?: unknown }).mapping : undefined;
      const mapping = checkMapping(input, row.headers.length);
      if (row.status !== 'uploaded') throw new AppError(409, ALREADY_STARTED);

      const planned = await buildImportView(tx, ctx, { ...row, mapping }, false);
      const saved = await setImportMapping(tx, ctx, id, mapping, planned.counts, now);
      if (!saved) throw new AppError(409, ALREADY_STARTED);
      return planned;
    });
    res.json(view);
  });

  router.post('/:id/start', requireCapability('import'), async (req, res) => {
    const { ctx } = req;
    const id = req.params.id as string;
    const body = parse(StartBody, req.body);
    const now = clock.now();
    const view = await withTenant(pools, ctx, async (tx) => {
      const row = await loadImport(tx, ctx, id);
      const mapping = row.mapping as ImportMapping;
      if (mapping.name === undefined && mapping.firstName === undefined && mapping.lastName === undefined) {
        throw new AppError(400, NAME_MESSAGE, 'mapping');
      }
      if (mapping.phone === undefined && mapping.email === undefined) {
        throw new AppError(400, CONTACT_MESSAGE, 'mapping');
      }

      const [company] = await tx
        .select({ name: companies.name })
        .from(companies)
        .where(eq(companies.id, ctx.companyId))
        .limit(1);
      const attested = body.consentAttested;
      const text = body.consentText ?? null;
      if (attested && text !== consentAttestationText(company?.name ?? '')) {
        throw new AppError(400, CONSENT_MESSAGE, 'consentText');
      }

      // Store the counts the job will work from, so the queued import shows them.
      const planned = await buildImportView(tx, ctx, row, false);
      await setImportMapping(tx, ctx, id, mapping, planned.counts, now);

      const started = await startImport(tx, ctx, id, { attested, text: attested ? text : null }, now);
      if (!started) throw new AppError(409, ALREADY_STARTED);
      await audit(tx, ctx, {
        action: 'import.started',
        targetType: 'import',
        targetId: id,
        after: { importId: id },
        ip: req.ip ?? null,
        at: now,
      });
      if (attested) {
        await audit(tx, ctx, {
          action: 'import.consent_attested',
          targetType: 'import',
          targetId: id,
          after: { importId: id, text },
          ip: req.ip ?? null,
          at: now,
        });
      }
      return buildImportView(tx, ctx, await loadImport(tx, ctx, id), false);
    });
    await sendJob(ctx.companyId, id);
    res.status(202).json(view);
  });

  router.post('/:id/retry', requireCapability('import'), async (req, res) => {
    const { ctx } = req;
    const id = req.params.id as string;
    const now = clock.now();
    const view = await withTenant(pools, ctx, async (tx) => {
      await loadImport(tx, ctx, id);
      const retried = await retryImport(tx, ctx, id, now);
      if (!retried) throw new AppError(409, NOT_FAILED);
      return buildImportView(tx, ctx, await loadImport(tx, ctx, id), false);
    });
    await sendJob(ctx.companyId, id);
    res.status(202).json(view);
  });

  router.get('/:id/skipped.csv', requireCapability('import'), async (req, res) => {
    const { ctx } = req;
    const id = req.params.id as string;
    const body = await withTenant(pools, ctx, async (tx) => {
      const row = await loadImport(tx, ctx, id);
      if (row.status !== 'done') throw new AppError(409, NOT_FINISHED);
      return skippedCsv(row.headers, await skippedImportRows(tx, ctx, id));
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="skipped-rows.csv"');
    res.send(body);
  });

  return router;
}
