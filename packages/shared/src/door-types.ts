// S1 door-knock routes: shared types and constants (Task 5). Final; builders do not edit.
export type Door = { key: string; lat: number; lng: number; hailIn: number };
export type PlannedRoute = { repIndex: number; doors: Door[]; walkMeters: number };
export const MAX_DOORS_PER_ROUTE = 150;
export const MAX_DOORS_PER_PLAN = 1500;
