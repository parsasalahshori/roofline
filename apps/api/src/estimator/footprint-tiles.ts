import { footprintTileStates, LOAD_HEARTBEAT_STALE_MS } from '@roofline/db/system';
import type { AppDeps } from '../app.ts';
import { loadFootprintTile, type TileLoadResult } from './footprints-load.ts';

/*
 * Building outlines for a measurement, now: the footprint tiles a home needs are loaded during the request when
 * they are not ready, so nobody has to trace a roof Microsoft has. A tile nobody is loading is loaded here (this
 * request claims it, so a queued job for it does nothing); a tile another process is loading (the worker, another
 * request) is waited for by watching its status; a claim whose heartbeat stopped (a process restarted mid-load) is
 * taken over. The wait is capped (FOOTPRINT_WAIT_MS); a load still going on then keeps going in the background.
 */

/** Whether every tile is ready, the wait ran out first, or a load failed (or footprints are not set up). */
export type TilesOutcome = 'ready' | 'timeout' | 'failed';

/** Loads this process has started, by tile, so a second request waits on the same load. */
const running = new WeakMap<AppDeps, Map<string, Promise<TileLoadResult>>>();

function runningFor(deps: AppDeps): Map<string, Promise<TileLoadResult>> {
  let map = running.get(deps);
  if (map === undefined) {
    map = new Map();
    running.set(deps, map);
  }
  return map;
}

/** Starts (or joins) this process's load of one tile. It runs to its end even when nobody waits for it any more. */
function startLoad(deps: AppDeps, quadkey: string, state: string | undefined): Promise<TileLoadResult> {
  const map = runningFor(deps);
  const existing = map.get(quadkey);
  if (existing !== undefined) return existing;
  const load = loadFootprintTile(deps, quadkey, { attempt: 1, lastAttempt: true }, state).finally(() => {
    if (map.get(quadkey) === load) map.delete(quadkey);
  });
  map.set(quadkey, load);
  deps.onBackgroundTask?.(load.then(
    () => undefined,
    () => undefined,
  ));
  return load;
}

type Raced<T> = { done: true; value: T } | { done: true; error: unknown } | { done: false };

/** The promise's outcome, or `done: false` when `deadline` (Date.now() ms) comes first. Never rejects. */
async function until<T>(promise: Promise<T>, deadline: number): Promise<Raced<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Raced<T>>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([
      promise.then(
        (value): Raced<T> => ({ done: true, value }),
        (error: unknown): Raced<T> => ({ done: true, error }),
      ),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readyOne(deps: AppDeps, quadkey: string, state: string | undefined, deadline: number, pollMs: number): Promise<TilesOutcome> {
  let tried = false;
  for (;;) {
    const mine = runningFor(deps).get(quadkey);
    if (mine !== undefined) {
      const r = await until(mine, deadline);
      if (!r.done) return 'timeout';
      if ('error' in r) return 'failed';
      tried = true;
      continue;
    }
    const tile = (await footprintTileStates(deps.pools.system, [quadkey])).get(quadkey);
    if (tile?.status === 'ready') return 'ready';
    const stale =
      tile?.status === 'loading' &&
      (tile.startedAt === null || deps.clock.now().getTime() - tile.startedAt.getTime() > LOAD_HEARTBEAT_STALE_MS);
    if (tile === undefined || tile.status === 'failed' || stale) {
      // A load that failed here already is not tried again in the same request.
      if (tried && tile?.status === 'failed') return 'failed';
      tried = true;
      const r = await until(startLoad(deps, quadkey, state), deadline);
      if (!r.done) return 'timeout';
      if ('error' in r) return 'failed';
      if (r.value === 'skipped') return 'failed';
      // 'loaded' is ready; 'busy' means another process claimed it a moment ago: watch it like any other load.
      continue;
    }
    // Another process is loading it: look again shortly.
    const left = deadline - Date.now();
    if (left <= 0) return 'timeout';
    await sleep(Math.min(pollMs, left));
  }
}

/**
 * Gets the tiles ready for a measurement, loading or waiting as needed, for at most `waitMs` (0: start any load
 * nobody is doing and return at once, for a prefetch). Never throws: a failure is the 'failed' outcome.
 */
export async function ensureFootprintTiles(
  deps: AppDeps,
  quadkeys: readonly string[],
  opts: { state?: string; waitMs: number },
): Promise<TilesOutcome> {
  if (quadkeys.length === 0) return 'ready';
  if (!deps.footprints.configured) return 'failed';
  const deadline = Date.now() + Math.max(0, opts.waitMs);
  const pollMs = Math.max(25, Math.min(1000, Math.floor(opts.waitMs / 40)));
  try {
    const outcomes = await Promise.all(quadkeys.map((q) => readyOne(deps, q, opts.state, deadline, pollMs)));
    if (outcomes.every((o) => o === 'ready')) return 'ready';
    return outcomes.includes('timeout') ? 'timeout' : 'failed';
  } catch {
    return 'failed';
  }
}
