import type { ExactReport } from '../exact-reports.ts';

/** Thrown when an EagleView report cannot be read as a US imperial measurement. Messages are our own text. */
export class EagleViewNormalizeError extends Error {}

type Unit = 'area' | 'length' | 'pitch' | 'count';

/** Exact v1 patterns (v1/server/providers.ts): commas are stripped before matching. */
const PATTERNS: Record<Unit, RegExp> = {
  area: /^(\d+(?:\.\d+)?)\s*(?:sq\.?\s*ft\.?|sqft|ft²)?$/i,
  length: /^(\d+(?:\.\d+)?)\s*(?:ft\.?|feet|')?$/i,
  pitch: /^(\d+(?:\.\d+)?)\s*(?:\/\s*12|:\s*12)?$/,
  count: /^(\d+)$/,
};

/** Reads one measurement. An optional measurement that is absent counts as zero. */
function evNumber(value: unknown, unit: Unit, optional = false): number {
  if ((value === undefined || value === null || value === '') && optional) return 0;
  const clean = String(value ?? '').trim().replace(/,/g, '');
  const match = clean.match(PATTERNS[unit]);
  if (!match || match[1] === undefined) {
    throw new EagleViewNormalizeError(`Report has missing or unsupported ${unit} measurements.`);
  }
  return Number(match[1]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Maps a completed EagleView report (GetReport body) to our ExactReport. Throws EagleViewNormalizeError. */
export function normalizeEagleView(raw: unknown): ExactReport {
  if (!isRecord(raw)) throw new EagleViewNormalizeError('Report is not in a readable format.');
  const r = raw;
  const total: Record<string, unknown> = isRecord(r.TotalMeasurements) ? r.TotalMeasurements : r;
  const value = (name: string): unknown => total[name] ?? r[name];

  const reportId = r.ReportId;
  const reportRef =
    typeof reportId === 'number' && Number.isFinite(reportId)
      ? String(reportId)
      : typeof reportId === 'string' && reportId.trim() !== ''
        ? reportId.trim()
        : null;
  if (reportRef === null) throw new EagleViewNormalizeError('Report has no report ID.');

  const facetsValue = value('TotalRoofFacets');
  // Eaves are where gutters go: kept on their own (the gutter total) as well as in the drip edge with the rakes.
  const eaveFt = evNumber(value('LengthEave'), 'length', true);
  const report: ExactReport = {
    surfaceSqFt: evNumber(value('Area'), 'area'),
    pitchX12: evNumber(value('PrimaryPitch') ?? r.Pitch, 'pitch'),
    ridgeFt: evNumber(value('LengthRidge'), 'length', true) + evNumber(value('LengthHip'), 'length', true),
    edgeFt: eaveFt + evNumber(value('LengthRake'), 'length', true),
    eaveFt,
    valleyFt: evNumber(value('LengthValley'), 'length', true),
    facets: facetsValue === undefined || facetsValue === null || facetsValue === '' ? null : evNumber(facetsValue, 'count'),
    reportRef,
  };

  const numbers = [report.surfaceSqFt, report.pitchX12, report.ridgeFt, report.edgeFt, report.eaveFt, report.valleyFt];
  if (!numbers.every((n) => Number.isFinite(n)) || (report.facets !== null && !Number.isFinite(report.facets))) {
    throw new EagleViewNormalizeError('Report has missing or unsupported measurements.');
  }
  if (report.surfaceSqFt <= 0) {
    throw new EagleViewNormalizeError('Report has missing or unsupported area measurements.');
  }
  return report;
}
