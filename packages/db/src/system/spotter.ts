import type { Db } from '../pools.ts';
import type { LngLat } from '../schema/columns.ts';
import { spotterReports } from '../schema/index.ts';

/** One NOAA/SPC spotter hail report, ready to store (S1 Task 8). Hail size is in inches. */
export type SpotterReport = {
  /** The convective-day date the report file is for, `YYYY-MM-DD`. */
  reportDate: string;
  /** UTC time of day, `HH:MM:SS`. */
  timeUtc: string;
  sizeIn: number;
  location: string | null;
  county: string | null;
  /** Two letters. */
  state: string;
  lat: number;
  lon: number;
};

const CHUNK = 500;

/** Stores spotter reports; a report already stored (same date, time and place) is skipped. Returns how many rows were new. */
export async function upsertSpotterReports(system: Db, reports: readonly SpotterReport[]): Promise<number> {
  if (reports.length === 0) return 0;
  const unique = new Map<string, SpotterReport>();
  for (const r of reports) {
    const key = `${r.reportDate}|${r.timeUtc}|${r.lon}|${r.lat}`;
    if (!unique.has(key)) unique.set(key, r);
  }
  const rows = [...unique.values()];
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((r) => ({
      reportDate: r.reportDate,
      timeUtc: r.timeUtc,
      sizeIn: r.sizeIn,
      location: r.location,
      county: r.county,
      state: r.state,
      geom: [r.lon, r.lat] as LngLat,
    }));
    const done = await system
      .insert(spotterReports)
      .values(chunk)
      .onConflictDoNothing({ target: [spotterReports.reportDate, spotterReports.timeUtc, spotterReports.geom] })
      .returning({ id: spotterReports.id });
    inserted += done.length;
  }
  return inserted;
}
