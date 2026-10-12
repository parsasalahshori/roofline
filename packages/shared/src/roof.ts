// scratch: T2's public types (from the T2 brief) so T4 compiles in parallel. T2 replaces this file.
export type LngLat = [number, number];
export type Ring = LngLat[];
export type Outline = Ring[];
export type InstantEstimate = { footprintSqFt: number; planSqFt: number; surfaceSqFt: number; squares: number; edgeFt: number; ridgeFt: number; valleyFt: number; pitchX12: number };
