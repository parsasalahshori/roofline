export type AerialRoof = { areaSqFt: number; pitchX12: number; structureIndex: number };
export interface AerialMeasure {
  readonly configured: boolean;
  start(address: string): Promise<{ requestId: string }>;
  result(requestId: string): Promise<{ status: 'pending' } | { status: 'complete'; roofs: AerialRoof[] }>;
}
export class AerialUnavailableError extends Error {}
