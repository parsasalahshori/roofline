/** One parsed SPC hail report. Matches SpotterReport in @roofline/db/system. */
export type SpotterReport = {
  reportDate: string;
  timeUtc: string;
  sizeIn: number;
  location: string | null;
  county: string | null;
  state: string;
  lat: number;
  lon: number;
};

const HEADER = 'Time,Size,Location,County,State,Lat,Lon,Comments';

/** Parses one NOAA/SPC hail report CSV. Bad rows are skipped, never thrown on. */
export function parseSpcHailCsv(csv: string, reportDate: string): SpotterReport[] {
  const lines = csv.trim().split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== HEADER) return [];
  const out: SpotterReport[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    if (c.length < 8) continue;
    const time = (c[0] ?? '').trim();
    if (!/^\d{4}$/.test(time)) continue;
    const hour = Number(time.slice(0, 2));
    const minute = Number(time.slice(2));
    if (hour > 23 || minute > 59) continue;
    const sizeText = (c[1] ?? '').trim();
    const size = Number(sizeText);
    if (sizeText === '' || sizeText.toUpperCase() === 'UNK' || !Number.isFinite(size) || size <= 0) continue;
    const latText = (c[5] ?? '').trim();
    const lonText = (c[6] ?? '').trim();
    if (latText === '' || lonText === '') continue;
    const lat = Number(latText);
    const lon = Number(lonText);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const state = (c[4] ?? '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(state)) continue;
    out.push({
      reportDate,
      timeUtc: `${time.slice(0, 2)}:${time.slice(2)}:00`,
      sizeIn: size / 100,
      location: (c[2] ?? '').trim() || null,
      county: (c[3] ?? '').trim() || null,
      state,
      lat,
      lon,
    });
  }
  return out;
}

export type SpotterDeps = { store: (reports: readonly SpotterReport[]) => Promise<number>; fetch?: typeof fetch };

/** Today's and yesterday's UTC dates (today first) as the SPC file code (yymmdd) and `YYYY-MM-DD`. */
export function convectiveDayCodes(now: Date): { code: string; date: string }[] {
  return [0, 1].map((back) => {
    const date = new Date(now.getTime() - back * 86_400_000).toISOString().slice(0, 10);
    return { code: date.slice(2).replaceAll('-', ''), date };
  });
}

/** Fetches the last two days of SPC hail reports and stores the new ones. Never throws on provider trouble. */
export async function syncSpotter(deps: SpotterDeps, now: Date): Promise<{ inserted: number }> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  let inserted = 0;
  for (const { code, date } of convectiveDayCodes(now)) {
    let text: string;
    try {
      const res = await doFetch(`https://www.spc.noaa.gov/climo/reports/${code}_rpts_hail.csv`, {
        signal: AbortSignal.timeout(10_000),
        headers: { 'User-Agent': 'Roofline/1.0' },
      });
      if (!res.ok) continue;
      text = await res.text();
    } catch {
      continue;
    }
    inserted += await deps.store(parseSpcHailCsv(text, date));
  }
  return { inserted };
}
