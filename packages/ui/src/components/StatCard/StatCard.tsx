import type { ReactNode } from 'react';
import { KpiTile } from '../KpiTile/KpiTile.tsx';

export type StatCardProps = {
  label: string;
  value: ReactNode;
  hint?: string;
};

/** One number with its name. The older name for a KPI tile without bars: it draws one. */
export function StatCard({ label, value, hint }: StatCardProps) {
  return <KpiTile label={label} value={value} meta={hint} />;
}
