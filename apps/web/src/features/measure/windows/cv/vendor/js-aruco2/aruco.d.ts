// Types for the vendored js-aruco2 (only what the engine uses).
export type ArucoCorner = { x: number; y: number };
export type ArucoMarker = { id: number; corners: ArucoCorner[]; hammingDistance: number };
export declare const AR: {
  DICTIONARIES: Record<string, { nBits: number; tau?: number; codeList: (number | string | number[])[] }>;
  Detector: new (config?: { dictionaryName?: string; maxHammingDistance?: number }) => {
    detect(image: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }): ArucoMarker[];
  };
};
