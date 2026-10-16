import { Router } from 'express';
import { z } from 'zod';
import { getMeasurement, gutterInputs, measurementRoof3d, roofPhotoGone, setGutterAdjustments, updateMeasurement, withTenant, type GutterInputs, type MeasurementPatch, type TenantContext } from '@roofline/db';
import { eaveHeight, gutterRuns, gutterView, MAX_DOWNSPOUTS_PER_RUN, MAX_EXCLUDED_FACETS, MAX_GUTTER_RUNS, type GutterMeasurementView, type MeasurementView, outlineProblem, solarDataCurrent, type LngLat, type Outline, type Ring } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { aerialMeasure } from '../estimator/aerial.ts';
import { requestExactReport } from '../estimator/exact-report.ts';
import { measureProperty, prefetchMeasure } from '../estimator/measure.ts';
import { measurementPreview } from '../estimator/preview.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { can } from '../permissions.ts';
import { assertKnownFields, noNul, parse, UUID } from '../validate.ts';

const PICK_ADDRESS_MESSAGE = 'Pick an address.';
const ADDRESS_MESSAGE = 'Please enter an address up to 300 characters.';
const CHECK_MESSAGE = 'Please check this field.';
const CORNERS_MESSAGE = 'Add at least three corners.';
const ONE_OUTLINE_MESSAGE = 'Please draw one outline for the house.';
const CROSSING_MESSAGE = 'Corners must form a closed shape without crossing lines.';
const TOO_LARGE_MESSAGE = 'That outline is too large for a house.';
const STRUCTURES_MESSAGE = 'Please pick the structures to include.';
const NO_STRUCTURE_MESSAGE = 'Keep at least one building in the quote.';
const FACETS_MESSAGE = 'Pick sections of this roof.';
const NO_FACETS_MESSAGE = 'Keep at least one section in the quote.';
const PITCH_MESSAGE = 'Please enter a pitch from 0 to 24.';
const OVERHANG_MESSAGE = 'Please enter an overhang from 0 to 3 feet.';
const VALLEY_MESSAGE = 'Please enter a valley length of 0 feet or more.';
const LOCKED_MESSAGE = 'Make a new measurement to change a sent proposal.';
/** B5: an exact report's numbers are what was measured; they are never edited. */
export const EXACT_LOCKED_MESSAGE = 'An exact report cannot be changed. Make a new measurement to change it.';
const EXACT_NOT_SET_UP_MESSAGE = "Exact reports aren't set up yet.";

const CREATE_FIELDS = ['propertyId', 'address', 'jobId'] as const;
const PREFETCH_FIELDS = ['propertyId', 'address'] as const;
const GUTTER_FIELDS = ['excludedRunIds', 'downspouts', 'size'] as const;
const PATCH_FIELDS = ['outline', 'includedStructures', 'pitchX12', 'overhangFt', 'valleyFt', 'excludedFacets'] as const;

/** Vertices a ring may have: a house has a few dozen corners; more is a bad or hostile outline. */
const MAX_RING_POINTS = 500;
const MAX_STRUCTURES = 50;
const MAX_VALLEY_FT = 10000;

/** Footprint ids are the global table's bigserial numbers, written as strings. */
const FOOTPRINT_ID = /^\d{1,19}$/;
/** Roof facet ids: 'A' to 'Z', then 'A2', 'B2', ... (see buildRoofModel). */
const FACET_ID = /^[A-Z]{1,2}\d{0,3}$/;

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
    /** Shape checked by checkExcludedFacets from `raw.excludedFacets` (so every problem names the list itself). */
    excludedFacets: z.unknown().optional(),
  })
  .strict();

const GUTTER_RUNS_MESSAGE = 'Pick gutter runs on this roof.';
const DOWNSPOUTS_MESSAGE = `Please enter 0 to ${MAX_DOWNSPOUTS_PER_RUN} downspouts for a run.`;
const GUTTER_SIZE_MESSAGE = 'Pick a 5 in or 6 in gutter.';
/** Gutter run ids: 'G1', 'G2', ... (see gutterRuns). */
const RUN_ID = /^G\d{1,3}$/;

const GutterBody = z
  .object({
    excludedRunIds: z.array(z.string().regex(RUN_ID), { error: GUTTER_RUNS_MESSAGE }).max(MAX_GUTTER_RUNS, GUTTER_RUNS_MESSAGE).optional(),
    downspouts: z
      .record(z.string().regex(RUN_ID, DOWNSPOUTS_MESSAGE), z.number({ error: DOWNSPOUTS_MESSAGE }).int(DOWNSPOUTS_MESSAGE).min(0, DOWNSPOUTS_MESSAGE).max(MAX_DOWNSPOUTS_PER_RUN, DOWNSPOUTS_MESSAGE), {
        error: DOWNSPOUTS_MESSAGE,
      })
      .refine((r) => Object.keys(r).length <= MAX_GUTTER_RUNS, DOWNSPOUTS_MESSAGE)
      .optional(),
    size: z.enum(['5in', '6in'], { error: GUTTER_SIZE_MESSAGE }).nullable().optional(),
  })
  .strict();

/** The gutter view of a measurement: worked out on read from its roof; quotes only for members who see money. */
function gutterViewFor(input: GutterInputs, ctx: TenantContext): GutterMeasurementView {
  const eave = eaveHeight({ eaveHeightM: input.eaveHeightM, floors: input.floors });
  return gutterView(input.view.id, input.view.roof, eave, input.adjustments, can(ctx, 'view_money_totals') ? undefined : null);
}

/** Roof sections to leave out of the quote: up to MAX_EXCLUDED_FACETS facet ids. */
const ExcludedFacets = z.array(z.string().regex(FACET_ID)).max(MAX_EXCLUDED_FACETS);

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

/** The roof sections sent on PATCH; anything else (not a list, a bad id, too many) is "pick sections", on the list. */
function checkExcludedFacets(raw: unknown): string[] {
  const parsed = ExcludedFacets.safeParse(raw);
  if (!parsed.success) throw new AppError(400, FACETS_MESSAGE, 'excludedFacets');
  return parsed.data;
}

/**
 * `/api/measurements`: measure a home from its building outline, read a measurement, and change it.
 * - POST takes a saved address (`propertyId`) or free text (`address`), and an optional job. 201 with the view.
 *   The first measurement in an area can take about 30 seconds (its building outlines load during the request).
 * - POST /prefetch takes the same address before Measure is pressed and starts that loading early (202).
 * - GET and PATCH answer the measurement view. PATCH changes the outline, the included structures (at least one
 *   when the home has any), pitch, overhang and valley, and `excludedFacets`: the roof sections (facet ids 'A',
 *   'B', ...) left out of the quote, replacing the list ([] quotes the whole roof). Each must be a section of the roof
 *   after the change and at least one must stay quoted; the estimate, and every price made from the measurement, is
 *   then the quoted sections' only. Without `excludedFacets`, a change of outline, structures, pitch or overhang keeps
 *   the same sections out only when the roof's sections are unchanged, else the whole roof is quoted again. A
 *   measurement with a sent proposal is locked (409).
 * Rep visibility and company isolation are enforced by the repository, so a measurement the caller
 * may not see is a 404.
 */
/** Google's roof photo is for the owner and office (as ordering reports is); others see the map's own photos. */
function seesRoofPhoto(ctx: TenantContext): boolean {
  return ctx.role === 'owner' || ctx.role === 'office';
}

/** The view as this member may have it: without the roof photo unless they may see it. */
function forViewer(view: MeasurementView, ctx: TenantContext): MeasurementView {
  if (seesRoofPhoto(ctx) || (view.roofPhoto == null && view.roofPhotoExpired !== true)) return view;
  return { ...view, roofPhoto: null, roofPhotoExpired: undefined };
}

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
    res.status(201).json(forViewer(view, ctx));
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
    const view = await withTenant(pools, ctx, (tx) => getMeasurement(tx, ctx, id, clock.now()));
    if (view === null) throw new AppError(404, MESSAGES.notFound);
    res.json(forViewer(view, ctx));
  });

  // Google's true-ortho photo of a roof measured in 3D (owner and office), a PNG kept with the measurement's 3D roof
  // for the 30 days the Solar API terms allow (the google-retention job deletes it then); 410 once it is past them
  // (deleted, or about to be), 404 when there never was one.
  router.get('/:id/roof-photo', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    if (!seesRoofPhoto(ctx)) throw new AppError(403, MESSAGES.roleCannot);
    const snapshot = await withTenant(pools, ctx, (tx) => measurementRoof3d(tx, ctx, id));
    if (roofPhotoGone(snapshot ?? null, clock.now())) throw new AppError(410, MESSAGES.googlePhotoExpired);
    const photo = snapshot?.photo ?? null;
    if (photo === null || !solarDataCurrent(snapshot, clock.now())) throw new AppError(404, MESSAGES.notFound);
    const bytes = await deps.objectStore.get(photo.key);
    // Named but no longer in the store: the sweep took it (its row is cleared on the same run).
    if (bytes === null) throw new AppError(410, MESSAGES.googlePhotoExpired);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(Buffer.from(bytes));
  });

  // The home and the three options as Make proposal would price them now (prices only for those who see money)
  router.get('/:id/preview', async (req, res) => {
    const { ctx } = req;
    res.json(await measurementPreview(deps, ctx, idParam(req.params.id)));
  });

  // Measure gutters: the roof's eaves as gutter runs, downspouts, size and Good/Better/Best (quotes null without money).
  router.get('/:id/gutters', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const input = await withTenant(pools, ctx, (tx) => gutterInputs(tx, ctx, id, clock.now()));
    if (input === null) throw new AppError(404, MESSAGES.notFound);
    res.json(gutterViewFor(input, ctx));
  });

  // The person's gutter changes, merged into the stored ones: runs left out (replacing the list), downspouts per run
  // (replacing the map) and the size (null: the recommended one). Every run id must be one of this roof's runs.
  router.patch('/:id/gutters', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const body = parse(GutterBody, assertKnownFields(req.body, GUTTER_FIELDS));
    const view = await withTenant(pools, ctx, async (tx) => {
      const input = await gutterInputs(tx, ctx, id, clock.now());
      if (input === null) throw new AppError(404, MESSAGES.notFound);
      const { runs } = gutterRuns(input.view.roof);
      const known = new Set(runs.map((r) => r.id));
      if ((body.excludedRunIds ?? []).some((r) => !known.has(r))) throw new AppError(400, GUTTER_RUNS_MESSAGE, 'excludedRunIds');
      if (Object.keys(body.downspouts ?? {}).some((r) => !known.has(r))) throw new AppError(400, GUTTER_RUNS_MESSAGE, 'downspouts');
      const next = {
        excludedRunIds: body.excludedRunIds ?? input.adjustments.excludedRunIds,
        downspouts: body.downspouts ?? input.adjustments.downspouts,
        size: body.size !== undefined ? body.size : input.adjustments.size,
      };
      const saved = await setGutterAdjustments(tx, ctx, id, runs, next, clock.now());
      if (saved === null) throw new AppError(404, MESSAGES.notFound);
      return gutterViewFor({ ...input, adjustments: saved }, ctx);
    });
    res.json(view);
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
    if ('excludedFacets' in raw) patch.excludedFacets = checkExcludedFacets(raw.excludedFacets);

    const result = await withTenant(pools, ctx, (tx) => updateMeasurement(tx, ctx, id, patch, clock.now()));
    if (result === null) throw new AppError(404, MESSAGES.notFound);
    if (result === 'exact') throw new AppError(409, EXACT_LOCKED_MESSAGE);
    if (result === 'locked') throw new AppError(409, LOCKED_MESSAGE);
    if (result === 'unknown_structure') throw new AppError(400, STRUCTURES_MESSAGE, 'includedStructures');
    if (result === 'no_structure') throw new AppError(400, NO_STRUCTURE_MESSAGE, 'includedStructures');
    if (result === 'unknown_facet') throw new AppError(400, FACETS_MESSAGE, 'excludedFacets');
    if (result === 'no_facets') throw new AppError(400, NO_FACETS_MESSAGE, 'excludedFacets');
    res.json(forViewer(result, ctx));
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
