// Error tables for the benchmark and the real-photo run.
export type Row = { method: string; errW: number[]; errH: number[]; refused: number; total: number };

const q = (xs: number[], p: number) => {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[i]!;
};
const median = (xs: number[]) => {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const f = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : '-');

/** A markdown table: absolute errors in inches (median, p90, p95, max) for width and height, and refusals. */
export function table(title: string, rows: Row[]): string {
  const lines = [`### ${title}`, '', '| method | n | refused | width median | p90 | p95 | max | height median | p90 | p95 | max |', '|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    const aw = r.errW.map(Math.abs);
    const ah = r.errH.map(Math.abs);
    lines.push(`| ${r.method} | ${aw.length} | ${r.refused}/${r.total} | ${f(median(aw))} | ${f(q(aw, 0.9))} | ${f(q(aw, 0.95))} | ${f(aw.length ? Math.max(...aw) : Number.NaN)} | ${f(median(ah))} | ${f(q(ah, 0.9))} | ${f(q(ah, 0.95))} | ${f(ah.length ? Math.max(...ah) : Number.NaN)} |`);
  }
  return lines.join('\n') + '\n';
}

export { median, q as quantile };
