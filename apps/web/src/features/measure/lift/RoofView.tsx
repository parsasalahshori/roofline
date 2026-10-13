import { useContext } from 'react';
import { MeasureSlotsContext } from './slots.ts';

/** The large roof view. Stub: shows the map and outline editor that MeasureWindow owns. Piece 7 replaces this file. */
export function RoofView({ measurementId }: { measurementId: string }) {
  const { map } = useContext(MeasureSlotsContext);
  return <div data-measurement-id={measurementId}>{map}</div>;
}
