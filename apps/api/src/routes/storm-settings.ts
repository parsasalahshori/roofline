import { createHash, randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler, Router } from 'express';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  audit,
  companySettings,
  insertDefaultSettings,
  storedFiles,
  stormPhotos,
  type Tx,
  withTenant,
} from '@roofline/db';
import {
  DEFAULT_STORM_EMAIL_BODY,
  DEFAULT_STORM_EMAIL_SUBJECT,
  DEFAULT_STORM_SMS,
  missingStormTokens,
} from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { requireCapability } from '../permissions.ts';
import { assertKnownFields, parse, TOO_LONG, UUID } from '../validate.ts';

/*
 * `/api/storm`: the storm settings (`/settings`) and the photos a company adds to its storm pages
 * (`/photos`). Every route needs `approve_internal` (the owner and office). Settings changes are
 * written with their audit row in one transaction, like routes/company.ts. Photos are sent as the
 * raw file bytes with the file's own Content-Type (the same as routes/imports.ts), not as multipart:
 * no multipart parser is installed.
 */

/** The hail sizes Radar shows on a company's settings: quarter-inch steps from 0.75 to 2. */
const HAIL_STEPS: readonly number[] = [0.75, 1, 1.25, 1.5, 1.75, 2];
const HAIL_MESSAGE = 'Please pick a hail size from 0.75 to 2 inches, in quarter-inch steps.';
const BUDGET_MESSAGE = 'Please enter a budget between $10 and $10,000.';
const DAYS_MESSAGE = 'Please enter a number of days between 1 and 30.';
const SHARE_MESSAGE = 'Please choose a share between 0 and 100.';
const YES_NO_MESSAGE = 'Please choose yes or no.';

const PHOTO_TYPE_MESSAGE = 'Please use a JPEG or PNG photo.';
const PHOTO_EMPTY_MESSAGE = 'Please choose a photo.';
const PHOTO_FULL_MESSAGE = 'You can add up to 5 photos. Remove one first.';
const PHOTO_TOO_BIG_MESSAGE = 'That photo is too big. Please use one under 5 MB.';
const STORAGE_DOWN_MESSAGE = "File storage isn't set up.";

const MAX_PHOTOS = 5;
const PHOTO_LIMIT_BYTES = 5 * 1024 * 1024;
const MAX_SMS_TEMPLATE = 600;
const MAX_EMAIL_SUBJECT = 200;
const MAX_EMAIL_TEMPLATE = 5000;

/** Text the company's own template text must keep, named in the error. */
const missingTokensMessage = (list: string[]) => `This text must keep ${list.join(', ')}.`;

const wholeNumber = (min: number, max: number, message: string) =>
  z.number({ error: message }).int(message).min(min, message).max(max, message);

/** What a company may set about its storm alerts. Every field is optional: a PUT changes only what it names. */
const SettingsPatch = z
  .object({
    thresholdIn: z
      .number({ error: HAIL_MESSAGE })
      .refine((v) => HAIL_STEPS.includes(v), HAIL_MESSAGE),
    adBudgetCents: wholeNumber(1000, 1_000_000, BUDGET_MESSAGE),
    adDays: wholeNumber(1, 30, DAYS_MESSAGE),
    adGoogleSharePct: wholeNumber(0, 100, SHARE_MESSAGE),
    emailEnabled: z.boolean({ error: YES_NO_MESSAGE }),
    smsTemplate: z.string({ error: MESSAGES.checkField }).max(MAX_SMS_TEMPLATE, TOO_LONG),
    emailSubject: z.string({ error: MESSAGES.checkField }).max(MAX_EMAIL_SUBJECT, TOO_LONG),
    emailTemplate: z.string({ error: MESSAGES.checkField }).max(MAX_EMAIL_TEMPLATE, TOO_LONG),
  })
  .partial();
const SETTINGS_FIELDS = Object.keys(SettingsPatch.shape);

type SettingsChanges = z.output<typeof SettingsPatch>;

/** The settings columns this route reads and writes. */
const SETTINGS_READ = {
  id: companySettings.id,
  hailThresholdIn: companySettings.hailThresholdIn,
  stormAdBudgetCents: companySettings.stormAdBudgetCents,
  stormAdDays: companySettings.stormAdDays,
  stormAdGoogleSharePct: companySettings.stormAdGoogleSharePct,
  stormEmailEnabled: companySettings.stormEmailEnabled,
  stormSmsTemplate: companySettings.stormSmsTemplate,
  stormEmailSubject: companySettings.stormEmailSubject,
  stormEmailTemplate: companySettings.stormEmailTemplate,
} as const;

type SettingsRow = { id: string } & Record<keyof Omit<typeof SETTINGS_READ, 'id'>, unknown>;

/**
 * The text a template field is stored as. Empty text, or text equal to the default, is stored as
 * NULL so the default keeps applying. Anything else must keep the tokens its channel needs (the
 * email subject has none). Throws the missing-token 400 for the field.
 */
function storedTemplate(
  text: string,
  field: 'smsTemplate' | 'emailSubject' | 'emailTemplate',
  defaultText: string,
  channel?: 'sms' | 'email',
): string | null {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === defaultText) return null;
  if (channel !== undefined) {
    const missing = missingStormTokens(trimmed, channel);
    if (missing.length > 0) throw new AppError(400, missingTokensMessage(missing), field);
  }
  return trimmed;
}

/** The column and stored value of each field the request changes. Templates are checked here. */
function columnChanges(changes: SettingsChanges): [keyof typeof SETTINGS_READ & string, unknown][] {
  const out: [keyof typeof SETTINGS_READ & string, unknown][] = [];
  if (changes.thresholdIn !== undefined) out.push(['hailThresholdIn', changes.thresholdIn]);
  if (changes.adBudgetCents !== undefined) out.push(['stormAdBudgetCents', changes.adBudgetCents]);
  if (changes.adDays !== undefined) out.push(['stormAdDays', changes.adDays]);
  if (changes.adGoogleSharePct !== undefined) out.push(['stormAdGoogleSharePct', changes.adGoogleSharePct]);
  if (changes.emailEnabled !== undefined) out.push(['stormEmailEnabled', changes.emailEnabled]);
  if (changes.smsTemplate !== undefined) {
    out.push(['stormSmsTemplate', storedTemplate(changes.smsTemplate, 'smsTemplate', DEFAULT_STORM_SMS, 'sms')]);
  }
  if (changes.emailSubject !== undefined) {
    out.push(['stormEmailSubject', storedTemplate(changes.emailSubject, 'emailSubject', DEFAULT_STORM_EMAIL_SUBJECT)]);
  }
  if (changes.emailTemplate !== undefined) {
    out.push([
      'stormEmailTemplate',
      storedTemplate(changes.emailTemplate, 'emailTemplate', DEFAULT_STORM_EMAIL_BODY, 'email'),
    ]);
  }
  return out;
}

/** The settings as the API shows them: the effective template text, the defaults, and the photos. */
function settingsBody(row: SettingsRow, photos: { id: string; createdAt: Date }[]) {
  return {
    thresholdIn: row.hailThresholdIn,
    adBudgetCents: row.stormAdBudgetCents,
    adDays: row.stormAdDays,
    adGoogleSharePct: row.stormAdGoogleSharePct,
    emailEnabled: row.stormEmailEnabled,
    smsTemplate: row.stormSmsTemplate ?? DEFAULT_STORM_SMS,
    emailSubject: row.stormEmailSubject ?? DEFAULT_STORM_EMAIL_SUBJECT,
    emailTemplate: row.stormEmailTemplate ?? DEFAULT_STORM_EMAIL_BODY,
    defaults: {
      smsTemplate: DEFAULT_STORM_SMS,
      emailSubject: DEFAULT_STORM_EMAIL_SUBJECT,
      emailTemplate: DEFAULT_STORM_EMAIL_BODY,
    },
    photos: photos.map(photoView),
    maxPhotos: MAX_PHOTOS,
  };
}

function photoView(photo: { id: string; createdAt: Date }) {
  return { id: photo.id, url: `/api/storm/photos/${photo.id}/file`, createdAt: photo.createdAt };
}

/** A photo's file type: what it is sent as, its file extension, and the bytes every such file starts with. */
const JPEG = { contentType: 'image/jpeg', ext: 'jpg', magic: [0xff, 0xd8, 0xff] } as const;
const PNG = { contentType: 'image/png', ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] } as const;

/** The photo type the request's Content-Type names, or null for anything else. Parameters (`; charset=…`) are ignored. */
function photoKind(header: string | undefined): typeof JPEG | typeof PNG | null {
  const type = (header ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === JPEG.contentType) return JPEG;
  if (type === PNG.contentType) return PNG;
  return null;
}

/** `bytes` begins with the signature of `kind`. */
const hasSignature = (bytes: Buffer, kind: typeof JPEG | typeof PNG): boolean =>
  kind.magic.every((byte, i) => bytes[i] === byte);

/** `/api/storm`: storm settings and storm photos, for the owner and office. */
export function stormSettingsRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();
  const guard = requireCapability('approve_internal');

  /** The company's settings row, made with the defaults if it is somehow missing. */
  const loadSettings = async (tx: Tx, companyId: string, lock = false): Promise<SettingsRow> => {
    const select = () => {
      const query = tx.select(SETTINGS_READ).from(companySettings).where(eq(companySettings.companyId, companyId)).limit(1);
      return lock ? query.for('update') : query;
    };
    let [row] = await select();
    if (!row) {
      await insertDefaultSettings(tx, companyId);
      [row] = await select();
    }
    return row as SettingsRow;
  };

  const loadPhotos = (tx: Tx, companyId: string) =>
    tx
      .select({ id: stormPhotos.id, createdAt: stormPhotos.createdAt })
      .from(stormPhotos)
      .where(eq(stormPhotos.companyId, companyId))
      .orderBy(asc(stormPhotos.createdAt), asc(stormPhotos.id));

  /** `body` with only the keys of `touched`, so an audit row records what the request was about. */
  const pick = (row: Record<string, unknown>, touched: readonly string[]) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => touched.includes(key)));

  router.get('/settings', guard, async (req, res) => {
    const { ctx } = req;
    res.json(
      await withTenant(pools, ctx, async (tx) =>
        settingsBody(await loadSettings(tx, ctx.companyId), await loadPhotos(tx, ctx.companyId)),
      ),
    );
  });

  router.put('/settings', guard, async (req, res) => {
    const { ctx } = req;
    const changes = parse(SettingsPatch, assertKnownFields(req.body, SETTINGS_FIELDS));
    const updates = columnChanges(changes);
    const touched = updates.map(([column]) => column);
    const now = clock.now();

    const result = await withTenant(pools, ctx, async (tx) => {
      const before = await loadSettings(tx, ctx.companyId, true);
      await tx
        .update(companySettings)
        .set({ ...Object.fromEntries(updates), updatedAt: now })
        .where(eq(companySettings.companyId, ctx.companyId));
      const after = await loadSettings(tx, ctx.companyId);
      await audit(tx, ctx, {
        action: 'storm_settings.update',
        targetType: 'company_settings',
        targetId: before.id,
        before: pick(before, touched),
        after: pick(after, touched),
        ip: req.ip ?? null,
        at: now,
      });
      return settingsBody(after, await loadPhotos(tx, ctx.companyId));
    });
    res.json(result);
  });

  // The file arrives as the raw body, with its own Content-Type. Only a photo under 5 MB is read.
  router.post(
    '/photos',
    guard,
    express.raw({ type: () => true, limit: PHOTO_LIMIT_BYTES }),
    async (req, res) => {
      const { ctx } = req;
      const kind = photoKind(req.headers['content-type']);
      if (kind === null) throw new AppError(400, PHOTO_TYPE_MESSAGE, 'photo');
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (bytes.length === 0) throw new AppError(400, PHOTO_EMPTY_MESSAGE, 'photo');
      if (!hasSignature(bytes, kind)) throw new AppError(400, PHOTO_TYPE_MESSAGE, 'photo');

      const countPhotos = async (tx: Tx) => (await loadPhotos(tx, ctx.companyId)).length;
      if ((await withTenant(pools, ctx, countPhotos)) >= MAX_PHOTOS) {
        throw new AppError(400, PHOTO_FULL_MESSAGE, 'photo');
      }
      if (!deps.objectStore.configured) throw new AppError(503, STORAGE_DOWN_MESSAGE);

      // The bytes are stored before the rows that point at them; a refused upload stores nothing.
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const objectKey = `${ctx.companyId}/storm-photos/${randomUUID()}.${kind.ext}`;
      await deps.objectStore.put(objectKey, bytes, kind.contentType);

      const now = clock.now();
      const photo = await withTenant(pools, ctx, async (tx) => {
        // Locking the settings row makes two uploads at once wait for each other before the count.
        await loadSettings(tx, ctx.companyId, true);
        if ((await countPhotos(tx)) >= MAX_PHOTOS) throw new AppError(400, PHOTO_FULL_MESSAGE, 'photo');
        const [file] = await tx
          .insert(storedFiles)
          .values({
            companyId: ctx.companyId,
            kind: 'storm_photo',
            objectKey,
            sha256,
            bytes: bytes.length,
            contentType: kind.contentType,
          })
          .returning({ id: storedFiles.id });
        const [row] = await tx
          .insert(stormPhotos)
          .values({ companyId: ctx.companyId, storedFileId: file!.id })
          .returning({ id: stormPhotos.id, createdAt: stormPhotos.createdAt });
        await audit(tx, ctx, {
          action: 'storm_photo.add',
          targetType: 'storm_photo',
          targetId: row!.id,
          after: { contentType: kind.contentType, bytes: bytes.length },
          ip: req.ip ?? null,
          at: now,
        });
        return row!;
      });
      res.status(201).json(photoView(photo));
    },
  );

  // A file over the limit is refused by express.raw before the handler above reads it.
  const uploadErrors: ErrorRequestHandler = (err, _req, res, next) => {
    if ((err as { type?: unknown } | null)?.type === 'entity.too.large') {
      res.status(413).json({ error: PHOTO_TOO_BIG_MESSAGE });
      return;
    }
    next(err);
  };
  router.use(uploadErrors);

  router.delete('/photos/:id', guard, async (req, res) => {
    const { ctx } = req;
    const rawId = req.params.id;
    const id = (typeof rawId === 'string' ? rawId : '').toLowerCase();
    // Another company's photo, one that does not exist and a malformed id all look the same.
    if (!UUID.test(id)) throw new AppError(404, MESSAGES.notFound);
    const now = clock.now();
    await withTenant(pools, ctx, async (tx) => {
      // The stored file row and its object are kept: app_tenant has no DELETE on stored_files.
      const [gone] = await tx
        .delete(stormPhotos)
        .where(and(eq(stormPhotos.id, id), eq(stormPhotos.companyId, ctx.companyId)))
        .returning({ id: stormPhotos.id, storedFileId: stormPhotos.storedFileId });
      if (!gone) throw new AppError(404, MESSAGES.notFound);
      await audit(tx, ctx, {
        action: 'storm_photo.remove',
        targetType: 'storm_photo',
        targetId: gone.id,
        before: { storedFileId: gone.storedFileId },
        ip: req.ip ?? null,
        at: now,
      });
    });
    res.status(204).end();
  });

  router.get('/photos/:id/file', guard, async (req, res) => {
    const { ctx } = req;
    const rawId = req.params.id;
    const id = (typeof rawId === 'string' ? rawId : '').toLowerCase();
    if (!UUID.test(id)) throw new AppError(404, MESSAGES.notFound);
    const [file] = await withTenant(pools, ctx, (tx) =>
      tx
        .select({ objectKey: storedFiles.objectKey, contentType: storedFiles.contentType })
        .from(stormPhotos)
        .innerJoin(
          storedFiles,
          and(eq(storedFiles.companyId, stormPhotos.companyId), eq(storedFiles.id, stormPhotos.storedFileId)),
        )
        .where(and(eq(stormPhotos.id, id), eq(stormPhotos.companyId, ctx.companyId)))
        .limit(1),
    );
    if (!file) throw new AppError(404, MESSAGES.notFound);
    if (!deps.objectStore.configured) throw new AppError(503, STORAGE_DOWN_MESSAGE);
    const bytes = await deps.objectStore.get(file.objectKey);
    if (bytes === null) throw new AppError(404, MESSAGES.notFound);
    res.set({
      'Content-Type': file.contentType,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(Buffer.from(bytes));
  });

  return router;
}
