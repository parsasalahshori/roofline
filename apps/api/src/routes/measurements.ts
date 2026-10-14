import { Router } from 'express';
import { z } from 'zod';
import { getMeasurement, updateMeasurement, withTenant, type MeasurementPatch } from '@roofline/db';
import { outlineProblem, type LngLat, type Outline, type Ring } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { aerialMeasure } from '../estimator/aerial.ts';
import { requestExactReport } from '../estimator/exact-report.ts';
import { measureProperty, prefetchMeasure } from '../estimator/measure.ts';
import { measurementPreview } from '../estimator/preview.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { assertKnownFields, noNul, parse, UUID } from '../validate.ts';

const PICK_ADDRESS_MESSAGE = 'Pick an address.';
const ADDRESS_MESSAGE = 'Please enter an address up to 300 characters.';
const CHECK_MESSAGE = 'Please check this field.';
const CORNERS_MESSAGE = 'Add at least three corners.';
const ONE_OUTLINE_MESSAGE = 'Please draw one outline for the house.';
const CROSSING_MESSAGE = 'Corners must form a closed shape without crossing lines.';
const TOO_LARGE_MESSAGE = 'That outline is too large for a house.';
const STRUCTURES_MESSAGE = 'Please pick the structures to include.';
const PITCH_MESSAGE = 'Please enter a pitch from 0 to 24.';
const OVERHANG_MESSAGE = 'Please enter an overhang from 0 to 3 feet.';
const VALLEY_MESSAGE = 'Please enter a valley length of 0 feet or more.';
const LOCKED_MESSAGE = 'Make a new measurement to change a sent proposal.';
/** B5: an exact report's numbers are what was measured; they are never edited. */
export const EXACT_LOCKED_MESSAGE = 'An exact report cannot be changed. Make a new measurement to change it.';
const EXACT_NOT_SET_UP_MESSAGE = "Exact reports aren't set up yet.";

const CREATE_FIELDS = ['propertyId', 'address', 'jobId'] as const;
const PREFETCH_FIELDS = ['propertyId', 'address'] as const;
const PATCH_FIELDS = ['outline', 'includedStructures', 'pitchX12', 'overhangFt', 'valleyFt'] as const;

/** Vertices a ring may have: a house has a few dozen corners; more is a bad or hostile outline. */
const MAX_RING_POINTS = 500;
const MAX_STRUCTURES = 50;
const MAX_VALLEY_FT = 10000;

/** Footprint ids are the global table's bigserial numbers, written as strings. */
const FOOTPRINT_ID = /^\d{1,19}$/;

const uuidField = z
  .string({ error: CHECK_MESSAGE })
  .regex(UUID, CHECK_MESSAGE)
  .transform((v) => v.toLowerCase());

const CreateBody = z
  .object({
    propertyId: uuidField.optional(),
    address: z
      .string({ error: ADDRESS_MESSAGE })
      .trim()
      .min(1, PICK_ADDRESS_MESSAGE)
      .max(300, ADDRESS_MESSAGE)
      .refine(noNul, CHECK_MESSAGE)
      .optional(),
    jobId: uuidField.nullish(),
  })
  .strict()
  .refine((b) => b.propertyId !== undefined || b.address !== undefined, { message: PICK_ADDRESS_MESSAGE, path: ['address'] });

const PrefetchBody = z
  .object({
    propertyId: uuidField.optional(),
    address: z
      .string({ error: ADDRESS_MESSAGE })
      .trim()
      .min(1, PICK_ADDRESS_MESSAGE)
      .max(300, ADDRESS_MESSAGE)
      .refine(noNul, CHECK_MESSAGE)
      .optional(),
  })
  .strict()
  .refine((b) => b.propertyId !== undefined || b.address !== undefined, { message: PICK_ADDRESS_MESSAGE, path: ['address'] });

const PatchBody = z
  .object({
    /** Shape checked by checkOutline from `raw.outline`; listed here only so strict() accepts the key. */
    outline: z.unknown().optional(),
    includedStructures: z
      .array(z.string({ error: STRUCTURES_MESSAGE }).regex(FOOTPRINT_ID, STRUCTURES_MESSAGE), { error: STRUCTURES_MESSAGE })
      .max(MAX_STRUCTURES, STRUCTURES_MESSAGE)
      .optional(),
    pitchX12: z.number({ error: PITCH_MESSAGE }).finite(PITCH_MESSAGE).min(0, PITCH_MESSAGE).max(24, PITCH_MESSAGE).optional(),
    overhangFt: z.number({ error: OVERHANG_MESSAGE }).finite(OVERHANG_MESSAGE).min(0, OVERHANG_MESSAGE).max(3, OVERHANG_MESSAGE).optional(),
    valleyFt: z
      .number({ error: VALLEY_MESSAGE })
      .finite(VALLEY_MESSAGE)
      .min(0, VALLEY_MESSAGE)
      .max(MAX_VALLEY_FT, VALLEY_MESSAGE)
      .optional(),
  })
  .strict();

/** `:id` as a lowercase UUID; anything else cannot be a measurement, so it is a 404 like a missing one. */
function idParam(raw: unknown): string {
  const id = (typeof raw === 'string' ? raw : '').toLowerCase();
  if (!UUID.test(id)) throw new AppError(404, MESSAGES.notFound);
  return id;
}

/** One point: [lng, lat] finite numbers in range. */
function isPoint(p: unknown): p is LngLat {
  if (!Array.isArray(p) || p.length !== 2) return false;
  const [lng, lat] = p as unknown[];
  return (
    typeof lng === 'number' &&
    typeof lat === 'number' &&
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    lng >= -180 &&
    lng <= 180 &&
    lat >= -90 &&
    lat <= 90
  );
}

/**
 * The outline sent on PATCH: exactly one ring of [lng, lat] points that is a closed, sensible shape.
 * Checked here, before any database work. Anything not shaped like rings of points is "add corners".
 */
function checkOutline(raw: unknown): Outline {
  if (!Array.isArray(raw)) throw new AppError(400, CORNERS_MESSAGE, 'outline');
  if (raw.length === 0) throw new AppError(400, CORNERS_MESSAGE, 'outline');
  if (raw.length > 1) throw new AppError(400, ONE_OUTLINE_MESSAGE, 'outline');
  const rawRing: unknown = raw[0];
  if (!Array.isArray(rawRing) || !rawRing.every(isPoint)) throw new AppError(400, CORNERS_MESSAGE, 'outline');
  if (rawRing.length > MAX_RING_POINTS) throw new AppError(400, TOO_LARGE_MESSAGE, 'outline');
  const ring = rawRing as Ring;
  const problem = outlineProblem(ring);
  if (problem === 'too_few_corners') throw new AppError(400, CORNERS_MESSAGE, 'outline');
  if (problem === 'self_intersecting') throw new AppError(400, CROSSING_MESSAGE, 'outline');
  if (problem === 'too_large') throw new AppError(400, TOO_LARGE_MESSAGE, 'outline');
  return [ring];
}

/**
 * `/api/measurements`: measure a home from its building outline, read a measurement, and change it.
 * - POST takes a saved address (`propertyId`) or free text (`address`), and an optional job. 201 with the view.
 *   The first measurement in an area can take about 30 seconds (its building outlines load during the request).
 * - POST /prefetch takes the same address before Measure is pressed and starts that loading early (202).
 * - GET and PATCH answer the measurement view. PATCH changes the outline, the included structures,
 *   pitch, overhang and valley; a measurement with a sent proposal is locked (409).
 * Rep visibility and company isolation are enforced by the repository, so a measurement the caller
 * may not see is a 404.
 */
export function measurementRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  router.post('/', async (req, res) => {
    const { ctx } = req;
    const body = parse(CreateBody, assertKnownFields(req.body, CREATE_FIELDS, { allowEmpty: true }));
    const view = await measureProperty(deps, ctx, {
      ...(body.propertyId !== undefined ? { propertyId: body.propertyId } : {}),
      ...(body.address !== undefined ? { address: body.address } : {}),
      jobId: body.jobId ?? null,
    });
    res.status(201).json(view);
  });

  // The Measure search's head start: the address is looked up and the area's outlines and Google Solar start
  // loading before Measure is pressed. 202 { found }; nothing is saved.
  router.post('/prefetch', async (req, res) => {
    const { ctx } = req;
    const body = parse(PrefetchBody, assertKnownFields(req.body, PREFETCH_FIELDS));
    const result = await prefetchMeasure(deps, ctx, {
      ...(body.propertyId !== undefined ? { propertyId: body.propertyId } : {}),
      ...(body.address !== undefined ? { address: body.address } : {}),
    });
    res.status(202).json(result);
  });

  router.get('/:id', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const view = await withTenant(pools, ctx, (tx) => getMeasurement(tx, ctx, id));
    if (view === null) throw new AppError(404, MESSAGES.notFound);
    res.json(view);
  });

  // The home and the three options as Make proposal would price them now (prices only for those who see money)
  router.get('/:id/preview', async (req, res) => {
    const { ctx } = req;
    res.json(await measurementPreview(deps, ctx, idParam(req.params.id)));
  });

  router.patch('/:id', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const raw = assertKnownFields(req.body, PATCH_FIELDS);
    const body = parse(PatchBody, raw);
    const patch: MeasurementPatch = {};
    if ('outline' in raw) patch.outline = checkOutline(raw.outline);
    if (body.includedStructures !== undefined) patch.includedStructures = body.includedStructures;
    if (body.pitchX12 !== undefined) patch.pitchX12 = body.pitchX12;
    if (body.overhangFt !== undefined) patch.overhangFt = body.overhangFt;
    if (body.valleyFt !== undefined) patch.valleyFt = body.valleyFt;

    const result = await withTenant(pools, ctx, (tx) => updateMeasurement(tx, ctx, id, patch, clock.now()));
    if (result === null) throw new AppError(404, MESSAGES.notFound);
    if (result === 'exact') throw new AppError(409, EXACT_LOCKED_MESSAGE);
    if (result === 'locked') throw new AppError(409, LOCKED_MESSAGE);
    if (result === 'unknown_structure') throw new AppError(400, STRUCTURES_MESSAGE, 'includedStructures');
    res.json(result);
  });

  router.post('/:id/exact-report', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    if (ctx.role !== 'owner' && ctx.role !== 'office') throw new AppError(403, MESSAGES.roleCannot);
    if (!deps.exactReports.configured) throw new AppError(503, EXACT_NOT_SET_UP_MESSAGE);
    const { taskId } = await requestExactReport(deps, ctx, id);
    res.status(201).json({ taskId });
  });

  router.post('/:id/aerial', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const view = await aerialMeasure(deps, ctx, id);
    res.status(201).json(view);
  });

  return router;
}
