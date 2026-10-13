import { createContext, type ReactNode } from 'react';

/**
 * What MeasureWindow's editor and numbers look like, handed down so RoofView and StatsPanel can place them.
 * MeasureWindow keeps every hook and handler; a RoofView or StatsPanel that draws its own content ignores this.
 */
export type MeasureSlots = { map: ReactNode; panels: ReactNode };

export const MeasureSlotsContext = createContext<MeasureSlots>({ map: null, panels: null });
