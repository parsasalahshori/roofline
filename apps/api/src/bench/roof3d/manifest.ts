import { createHash } from 'node:crypto';
import { z } from 'zod';

/*
 * The benchmark's list of houses, frozen in <ROOF_BENCH_DIR>/manifest.json: where each house's data is, the point to
 * measure at, its truth grade, its cohort tags (made once from the data, see cohorts) and when Google's data was
 * downloaded (the Solar API terms allow keeping it 30 days; the benchmark refuses to run on data past its date).
 */

export const SETS = ['testset', 'testset-ev', 'testset-trees'] as const;
export type BenchSet = (typeof SETS)[number];
/** 'lidar': an outline and planes from USGS 3DEP lidar (lidar.ts), accepted by its own validation. */
export const TRUTH_GRADES = ['eagleview', 'visual', 'lidar', 'proxy'] as const;
export type TruthGrade = (typeof TRUTH_GRADES)[number];
export const SPLITS = ['dev', 'heldout'] as const;
export type Split = (typeof SPLITS)[number];

/** HELD-OUT when sha1(slug), read as one big-endian integer, mod 10 is below this. */
export const HELDOUT_BELOW = 3;
export const SPLIT_RULE = `sha1(slug) mod 10 < ${HELDOUT_BELOW} => heldout, else dev`;

/** The split of a house: a pure function of its name, so it never moves when houses are added. */
export function splitOf(slug: string): Split {
  const digest = createHash('sha1').update(slug, 'utf8').digest('hex');
  return Number(BigInt(`0x${digest}`) % 10n) < HELDOUT_BELOW ? 'heldout' : 'dev';
}

const Date10 = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CANOPY_CLASSES = ['none', 'light', 'heavy'] as const;
export type CanopyClass = (typeof CANOPY_CLASSES)[number];

/** Thresholds of the cohort tags, kept in the manifest so a tag can be re-derived and audited. */
export const ThresholdsSchema = z.object({
  /** canopy heavy: rimShare >= heavyRim, roofShare >= heavyRoof or biteShare >= heavyBite; light: the same with the light limits. */
  heavyRim: z.number(),
  heavyRoof: z.number(),
  heavyBite: z.number(),
  lightRim: z.number(),
  lightRoof: z.number(),
  lightBite: z.number(),
  /** simple: at most this many EagleView faces (or, without EagleView, Google roof segments scaled by googleSegmentsPerSimple). */
  simpleMaxFaces: z.number(),
  simpleMaxGoogleSegments: z.number(),
  /** low slope: a face of at least this sloped area (sq ft) at or under this pitch (x/12). */
  lowSlopeMaxPitchX12: z.number(),
  lowSlopeMinSqFt: z.number(),
  steepMinPitchX12: z.number(),
});
export type Thresholds = z.infer<typeof ThresholdsSchema>;

export const HouseSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  set: z.enum(SETS),
  /** The house's folder under the data root: <set>/<slug>. */
  dir: z.string(),
  /** [lng, lat]: the point the roof is measured at (EagleView's own point for EagleView houses). */
  point: z.tuple([z.number(), z.number()]),
  address: z.string(),
  region: z.object({ state: z.string(), metro: z.string() }),
  split: z.enum(SPLITS),
  truth: z.enum(TRUTH_GRADES),
  tags: z.object({
    canopy: z.object({ roofShare: z.number(), rimShare: z.number(), biteShare: z.number(), class: z.enum(CANOPY_CLASSES) }).nullable(),
    complexity: z.object({ class: z.enum(['simple', 'complex']), faces: z.number(), source: z.enum(['eagleview', 'google-segments']) }),
    lowSlope: z.boolean(),
    steep: z.boolean(),
    /** The area-dominant pitch (x/12) the steep tag came from, and whose it is. */
    mainPitchX12: z.number().nullable(),
    pitchSource: z.enum(['eagleview', 'google-segments']),
  }),
  data: z.object({
    /** Null when the date is not known (the earliest plausible date is then in deleteBy). */
    downloadedAt: Date10.nullable(),
    deleteBy: Date10,
    imageryQuality: z.string().nullable(),
    imageryDate: Date10.nullable(),
  }),
  /** How a tree house was picked (candidate scores from free sources); absent on the earlier houses. */
  selection: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  /**
   * The house's lidar truth grade from <bench>/lidar/index.json, merged in when the benchmark loads (withLidar); never
   * stored in manifest.json, so adding lidar truth does not change the manifest or its hash.
   */
  lidar: z.object({ grade: z.enum(['lidar', 'rejected', 'none']), leafOff: z.boolean().nullable() }).optional(),
  /** The house's county truth grade from <bench>/free/county/index.json (county.ts), merged in like lidar (withCounty). */
  county: z.object({ grade: z.enum(['county', 'rejected', 'none']), lidarDerived: z.boolean() }).optional(),
});
export type HouseEntry = z.infer<typeof HouseSchema>;

export const ManifestSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  splitRule: z.string(),
  thresholds: ThresholdsSchema,
  houses: z.array(HouseSchema),
});
export type Manifest = z.infer<typeof ManifestSchema>;

/** A short fingerprint of what a manifest holds (slugs, points, tags, splits, truth): the baseline records it. */
export function manifestHash(m: Manifest): string {
  const core = m.houses.map((h) => [h.slug, h.point, h.split, h.truth, h.tags, h.set]);
  return createHash('sha1').update(JSON.stringify(core)).digest('hex').slice(0, 12);
}

/** Checks the frozen split against the rule, slugs for uniqueness; returns problems (empty when sound). */
export function manifestProblems(m: Manifest): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const h of m.houses) {
    if (seen.has(h.slug)) problems.push(`duplicate house ${h.slug}`);
    seen.add(h.slug);
    if (h.split !== splitOf(h.slug)) problems.push(`${h.slug}: split ${h.split} breaks the frozen rule (${SPLIT_RULE})`);
    if (h.dir !== `${h.set}/${h.slug}`) problems.push(`${h.slug}: dir ${h.dir} is not ${h.set}/${h.slug}`);
  }
  return problems;
}

/** Houses whose Google data is past its delete-by date at `today` (YYYY-MM-DD). */
export function expiredHouses(m: Manifest, today: string): HouseEntry[] {
  return m.houses.filter((h) => h.data.deleteBy < today);
}

export function parseManifest(json: unknown): Manifest {
  return ManifestSchema.parse(json);
}

/** The cohorts a house belongs to (names usable with --cohort). */
export function cohortsOf(h: HouseEntry): string[] {
  const out = ['all', `set-${h.set}`, `state-${h.region.state}`, `truth-${h.truth}`, h.tags.complexity.class, `split-${h.split}`];
  if (h.tags.canopy !== null) out.push(`canopy-${h.tags.canopy.class}`);
  if (h.tags.canopy !== null && h.tags.canopy.class !== 'none') out.push('canopy-any');
  if (h.tags.lowSlope) out.push('lowslope');
  if (h.tags.steep) out.push('steep');
  if (h.truth !== 'proxy') out.push('has-truth');
  // Lidar truth is a second answer key: an EagleView house can have it too.
  if (h.truth !== 'lidar' && h.lidar?.grade === 'lidar') out.push('truth-lidar');
  // County footprints (county.ts) are a third, outline-only key.
  if (h.county?.grade === 'county') out.push('truth-county');
  return out;
}

/** The manifest with each house's lidar grade from the lidar index merged in (houses the index lacks get none). */
export function withLidar(m: Manifest, index: { houses: Record<string, { grade: 'lidar' | 'rejected' | 'none'; leafOff?: boolean | null }> } | null): Manifest {
  if (index === null) return m;
  return {
    ...m,
    houses: m.houses.map((h) => {
      const e = index.houses[h.slug];
      return { ...h, lidar: e === undefined ? { grade: 'none' as const, leafOff: null } : { grade: e.grade, leafOff: e.leafOff ?? null } };
    }),
  };
}

/** The manifest with each house's county grade merged in (houses the index lacks get none). */
export function withCounty(m: Manifest, index: { houses: Record<string, { grade: 'county' | 'rejected' | 'none'; lidarDerived: boolean }> } | null): Manifest {
  if (index === null) return m;
  return {
    ...m,
    houses: m.houses.map((h) => {
      const e = index.houses[h.slug];
      return { ...h, county: e === undefined ? { grade: 'none' as const, lidarDerived: false } : { grade: e.grade, lidarDerived: e.lidarDerived } };
    }),
  };
}

/** "street, City, ST 12345" to state and metro. */
export function regionOf(address: string): { state: string; metro: string } {
  const m = /,\s*([^,]+),\s*([A-Z]{2})\b/.exec(address);
  return m ? { state: m[2]!, metro: m[1]!.trim() } : { state: '??', metro: '??' };
}
