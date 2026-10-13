import { useContext, type ReactNode } from 'react';
import { MeasureSlotsContext } from './slots.ts';

/** The numbers and controls, with the action buttons last. Stub: shows what MeasureWindow owns. Piece 7 replaces this file. */
export function StatsPanel({ measurementId, actions }: { measurementId: string; actions?: ReactNode }) {
  const { panels } = useContext(MeasureSlotsContext);
  return (
    <div data-measurement-id={measurementId}>
      {panels}
      {actions}
    </div>
  );
}
