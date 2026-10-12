import {
  type HomeInZone,
  insertRoutesOnce,
  listBuiltRoutes,
  listHomesInZone,
  type NewRoute,
  type TenantContext,
  withTenant,
} from '@roofline/db';
import { sql } from 'drizzle-orm';
import { type Door, pickDoors, type StepResult, splitIntoRoutes, stepTypes } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { GeocoderUnavailableError } from '../providers/geocoder.ts';
import type { StepHandler } from '../tasks/runner.ts';

/** The most points sent to the reverse geocoder in one call. */
export const REVERSE_CHUNK = 1000;

const UNREADABLE = "We couldn't read this plan. Please make it again.";
const NO_STORM = "We couldn't find that storm. Please make this plan again.";

type Summary = { routes: number; doors: number; byRep: { userId: string; doors: number }[] };

/** The step result for a set of routes: route and door counts, and doors per rep in `repUserIds` order. */
function summarize(routes: { userId: string; stops: number }[], repUserIds: readonly string[]): Summary {
  const perRep = new Map<string, number>();
  let doors = 0;
  for (const r of routes) {
    perRep.set(r.userId, (perRep.get(r.userId) ?? 0) + r.stops);
    doors += r.stops;
  }
  const order = [...repUserIds];
  for (const id of perRep.keys()) if (!order.includes(id)) order.push(id);
  const byRep = order.filter((id) => perRep.has(id)).map((id) => ({ userId: id, doors: perRep.get(id) ?? 0 }));
  return { routes: routes.length, doors, byRep };
}

/** `byRep` is an array, which StepResult's type does not allow; the brief and tests require it. */
function asResult(s: Summary): StepResult {
  return s as unknown as StepResult;
}

function fallbackAddress(h: HomeInZone): string {
  return `Near ${h.lat.toFixed(4)}, ${h.lng.toFixed(4)}`;
}

/**
 * The `build_routes` step: turns the homes inside a storm's hail zone into door-to-door routes, one
 * or more per rep. It is safe to run again; a company storm has one set of routes.
 * 1. One transaction reads the company storm (missing: needs attention), then the routes already
 *    built (if any, the step is done with those), else the hail threshold, the company city, the reps'
 *    names and the homes in the zone.
 * 2. Outside any transaction the homes are cut down to `maxDoors` (pickDoors) and split into routes
 *    in walking order (splitIntoRoutes, seeded by the company storm id). No doors: done, nothing written.
 * 3. Homes with no saved address are reverse geocoded in chunks of REVERSE_CHUNK. A point with no
 *    result, or a chunk the geocoder could not do, gets "Near lat, lng". Saved addresses are kept.
 *    Stops carry an address only, never an owner name.
 * 4. Routes are numbered 1..N across the plan and named "<City> · Route <n> (<rep first name>)".
 * 5. A second transaction writes them with insertRoutesOnce, which takes an advisory lock and returns
 *    the existing routes when another run got there first.
 * The result is { routes, doors, byRep: [{ userId, doors }] }.
 */
export const buildRoutesHandler: StepHandler = async (deps: AppDeps, ctx: TenantContext, step) => {
  const parsed = stepTypes.build_routes.payload.safeParse(step.payload);
  if (!parsed.success) return { status: 'needs_attention', result: {}, errorPlain: UNREADABLE };
  const { companyStormId, repUserIds, maxDoors } = parsed.data;

  const loaded = await withTenant(deps.pools, ctx, async (tx) => {
    const storm = await tx.execute(sql`select storm_id from company_storms where id = ${companyStormId}`);
    const stormRow = storm.rows[0];
    if (!stormRow) return { kind: 'missing' as const };
    const existing = await listBuiltRoutes(tx, companyStormId);
    if (existing.length > 0) return { kind: 'existing' as const, existing };

    const settings = await tx.execute(sql`select hail_threshold_in from company_settings limit 1`);
    const rawThreshold = settings.rows[0]?.hail_threshold_in;
    const threshold = rawThreshold === undefined || rawThreshold === null ? 1 : Number(rawThreshold);

    const co = await tx.execute(sql`select address_city, name from companies where id = ${ctx.companyId}`);
    const coRow = co.rows[0];
    const cityRaw = typeof coRow?.address_city === 'string' ? coRow.address_city.trim() : '';
    const city = cityRaw !== '' ? cityRaw : String(coRow?.name ?? '').trim();

    const repList = sql.join(repUserIds.map((id: string) => sql`${id}`), sql`, `);
    const members = await tx.execute(
      sql`select user_id, name from company_members where status = 'active' and user_id = any(array[${repList}]::uuid[])`,
    );
    const shortNames = new Map<string, string>();
    for (const m of members.rows) {
      const first = String(m.name ?? '').trim().split(/\s+/)[0] ?? '';
      shortNames.set(String(m.user_id), first !== '' ? first : 'Rep');
    }

    const homes = await listHomesInZone(tx, String(stormRow.storm_id), threshold);
    return { kind: 'plan' as const, city, shortNames, homes };
  });

  if (loaded.kind === 'missing') return { status: 'needs_attention', result: {}, errorPlain: NO_STORM };
  if (loaded.kind === 'existing') {
    return { status: 'done', result: asResult(summarize(loaded.existing, repUserIds)) };
  }

  const { city, shortNames, homes } = loaded;
  const byKey = new Map<string, HomeInZone>();
  const doors: Door[] = [];
  for (const h of homes) {
    const key = String(h.footprintId);
    byKey.set(key, h);
    doors.push({ key, lat: h.lat, lng: h.lng, hailIn: h.hailIn });
  }
  const picked = pickDoors(doors, maxDoors);
  if (picked.length === 0) return { status: 'done', result: asResult({ routes: 0, doors: 0, byRep: [] }) };
  const planned = splitIntoRoutes(picked, repUserIds.length, companyStormId);

  const addresses = new Map<string, string>();
  const needAddress = picked
    .map((d) => byKey.get(d.key))
    .filter((h): h is HomeInZone => h !== undefined && (h.address === null || h.address === ''));
  for (let i = 0; i < needAddress.length; i += REVERSE_CHUNK) {
    const chunk = needAddress.slice(i, i + REVERSE_CHUNK);
    let results: Awaited<ReturnType<AppDeps['geocoder']['reverseMany']>> = chunk.map(() => null);
    try {
      results = await deps.geocoder.reverseMany(chunk.map((h) => ({ lat: h.lat, lng: h.lng })));
    } catch (err) {
      if (!(err instanceof GeocoderUnavailableError)) throw err;
    }
    chunk.forEach((h, j) => {
      const r = results[j];
      addresses.set(String(h.footprintId), r ? `${r.street}, ${r.city}, ${r.state} ${r.zip}` : fallbackAddress(h));
    });
  }

  const newRoutes: NewRoute[] = planned.map((route, idx) => {
    const userId = repUserIds[route.repIndex] as string;
    return {
      userId,
      name: `${city} · Route ${idx + 1} (${shortNames.get(userId) ?? 'Rep'})`,
      stops: route.doors.map((d) => {
        const h = byKey.get(d.key) as HomeInZone;
        const saved = h.address !== null && h.address !== '' ? h.address : null;
        return {
          footprintId: h.footprintId,
          propertyId: h.propertyId,
          lng: h.lng,
          lat: h.lat,
          address: saved ?? addresses.get(d.key) ?? fallbackAddress(h),
          hailIn: h.hailIn,
        };
      }),
    };
  });

  const written = await withTenant(deps.pools, ctx, (tx) => insertRoutesOnce(tx, companyStormId, newRoutes));
  return { status: 'done', result: asResult(summarize(written.routes, repUserIds)) };
};
