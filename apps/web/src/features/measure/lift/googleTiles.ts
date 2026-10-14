import type { StyleSpecification } from 'maplibre-gl';

/*
 * Google satellite photos for the roof view (Map Tiles API, 2D tiles). A tile URL needs a session token, made once
 * per browser and reused until shortly before it expires; the key is the build-time VITE_GOOGLE_MAPS_KEY.
 */

const SESSION_URL = 'https://tile.googleapis.com/v1/createSession';
const TILE_URL = 'https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}';
const STORE_KEY = 'roofline.googleTileSession';
/** Renew a day before Google's expiry, so a long-open tab never draws with a dead token. */
const RENEW_EARLY_MS = 24 * 60 * 60 * 1000;

type Session = { token: string; expiresAt: number };

let current: Session | null = null;
let pending: Promise<Session | null> | null = null;

export function googleKey(): string | undefined {
  const key = (import.meta.env.VITE_GOOGLE_MAPS_KEY ?? '').trim();
  return key === '' ? undefined : key;
}

function fresh(s: Session | null): s is Session {
  return s !== null && s.expiresAt - RENEW_EARLY_MS > Date.now();
}

function stored(): Session | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const s = raw === null ? null : (JSON.parse(raw) as Session);
    return s !== null && typeof s.token === 'string' && typeof s.expiresAt === 'number' ? s : null;
  } catch {
    return null;
  }
}

/** Starts (or reuses) the tile session; null when there is no key or Google refuses. Never throws. */
export function ensureGoogleSession(): Promise<Session | null> {
  const key = googleKey();
  if (key === undefined || typeof fetch !== 'function') return Promise.resolve(null);
  if (fresh(current)) return Promise.resolve(current);
  const saved = stored();
  if (fresh(saved)) {
    current = saved;
    return Promise.resolve(saved);
  }
  pending ??= fetch(`${SESSION_URL}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapType: 'satellite', language: 'en-US', region: 'US', scale: 'scaleFactor2x', highDpi: true }),
  })
    .then((res) => (res.ok ? (res.json() as Promise<{ session?: string; expiry?: string }>) : null))
    .then((answer) => {
      if (!answer?.session || !answer.expiry) return null;
      const s = { token: answer.session, expiresAt: Number(answer.expiry) * 1000 };
      current = s;
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(s));
      } catch {
        // A browser without storage just makes a new session next load.
      }
      return s;
    })
    .catch(() => null)
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** The Google satellite style when a session is ready right now; null otherwise (the caller keeps its fallback). */
export function googleSatelliteStyle(): StyleSpecification | null {
  const key = googleKey();
  if (key === undefined || !fresh(current)) return null;
  const url = `${TILE_URL}?session=${encodeURIComponent(current.token)}&key=${encodeURIComponent(key)}`;
  return {
    version: 8,
    sources: {
      google: { type: 'raster', tiles: [url], tileSize: 256, maxzoom: 21, attribution: 'Imagery © Google' },
    },
    layers: [{ id: 'google', type: 'raster', source: 'google' }],
  };
}

/** True when the roof view is drawing Google's photos. */
export function usesGoogleImagery(): boolean {
  return googleSatelliteStyle() !== null;
}

// Start the session as soon as the app loads, so it is ready before the roof view opens.
void ensureGoogleSession();
