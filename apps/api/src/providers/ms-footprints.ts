import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pipeline as pipelineCb } from 'node:stream';
import { promisify } from 'node:util';
import yauzl from 'yauzl';
import parser from 'stream-json/parser.js';
import pick from 'stream-json/filters/pick.js';
import streamArray from 'stream-json/streamers/stream-array.js';
import type { Ring } from '@roofline/shared';
import type { Config } from '../config.ts';
import { FootprintsUnavailableError } from './footprints.ts';
import type { FootprintFeature, FootprintSource } from './footprints.ts';

/*
 * Legacy source: the per-state zips of Microsoft US Building Footprints, read from FOOTPRINTS_BASE_URL.
 * Microsoft's public host for these files (usbuildingdata.blob.core.windows.net) now refuses downloads,
 * so this runs only when FOOTPRINTS_BASE_URL points at a mirror. The default is global-footprints.ts.
 */

/** USPS code -> Microsoft file stem (full state name with spaces removed). */
export const STATE_FILE_NAMES: Record<string, string> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'DistrictofColumbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'NewHampshire',
  NJ: 'NewJersey',
  NM: 'NewMexico',
  NY: 'NewYork',
  NC: 'NorthCarolina',
  ND: 'NorthDakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'RhodeIsland',
  SC: 'SouthCarolina',
  SD: 'SouthDakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'WestVirginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
};

export const TMP_PREFIX = 'roofline-footprints-';

const yauzlOpen = promisify(yauzl.open.bind(yauzl)) as (
  path: string,
  options: yauzl.Options,
) => Promise<yauzl.ZipFile>;

/** Opens the first .geojson/.json entry of the zip as a readable stream. */
async function openFirstEntry(zipPath: string): Promise<{ zip: yauzl.ZipFile; stream: Readable }> {
  const zip = await yauzlOpen(zipPath, { lazyEntries: true, autoClose: false });
  try {
    const entry = await new Promise<yauzl.Entry>((resolve, reject) => {
      zip.on('entry', (e: yauzl.Entry) => {
        if (/\.(geojson|json)$/i.test(e.fileName) && !e.fileName.endsWith('/')) resolve(e);
        else zip.readEntry();
      });
      zip.once('end', () => reject(new Error('The footprint file has no data in it.')));
      zip.once('error', () => reject(new Error('The footprint file could not be read.')));
      zip.readEntry();
    });
    const open = promisify(zip.openReadStream.bind(zip)) as (e: yauzl.Entry) => Promise<Readable>;
    return { zip, stream: await open(entry) };
  } catch (err) {
    zip.close();
    throw err;
  }
}

function isRing(v: unknown): v is Ring {
  if (
    !(
      Array.isArray(v) &&
      v.length >= 4 &&
      v.every(
        (p) =>
          Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]),
      )
    )
  )
    return false;
  const a = v[0] as number[];
  const b = v[v.length - 1] as number[];
  return a[0] === b[0] && a[1] === b[1];
}

export class MicrosoftFootprints implements FootprintSource {
  readonly configured = true;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(o: { baseUrl: string; fetch?: typeof fetch }) {
    this.baseUrl = o.baseUrl;
    this.fetchImpl = o.fetch ?? ((...a) => fetch(...a));
  }

  stateFileUrl(state: string): string {
    const stem = STATE_FILE_NAMES[state.toUpperCase()];
    if (!stem) throw new FootprintsUnavailableError("Building footprints aren't available for that state.");
    return `${this.baseUrl}${stem}.geojson.zip`;
  }

  async *features(state: string): AsyncGenerator<FootprintFeature> {
    const url = this.stateFileUrl(state);
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`The footprint download failed with status ${res.status}.`);
    if (!res.body) throw new Error('The footprint download came back empty.');

    const dir = await mkdtemp(join(tmpdir(), TMP_PREFIX));
    let zip: yauzl.ZipFile | null = null;
    let chain: Readable | null = null;
    try {
      const zipPath = join(dir, 'state.zip');
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(zipPath));
      const opened = await openFirstEntry(zipPath);
      zip = opened.zip;
      chain = pipelineCb(
        opened.stream,
        parser.asStream(),
        pick.asStream({ filter: 'features' }),
        streamArray.asStream(),
        () => {},
      ) as unknown as Readable;
      let index = -1;
      for await (const item of chain as AsyncIterable<{ key: number; value: unknown }>) {
        index++;
        const f = item.value as {
          properties?: { id?: unknown; ID?: unknown } | null;
          geometry?: { type?: string; coordinates?: unknown[] } | null;
        } | null;
        if (f?.geometry?.type !== 'Polygon') continue;
        const ring = f.geometry.coordinates?.[0];
        if (!isRing(ring)) continue;
        const id = f.properties?.id ?? f.properties?.ID ?? index;
        yield { sourceRef: String(id), ring };
      }
    } finally {
      chain?.destroy();
      zip?.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** The legacy source when FOOTPRINTS_BASE_URL is set, else null. */
export function msFootprintsFor(config: Config): FootprintSource | null {
  if (!config.FOOTPRINTS_BASE_URL) return null;
  return new MicrosoftFootprints({ baseUrl: config.FOOTPRINTS_BASE_URL });
}
