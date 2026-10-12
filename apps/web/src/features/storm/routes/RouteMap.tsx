import { Map as MapLibreMap, Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef } from 'react';
import { doors } from '../../../copy/doors.ts';
import { mapStyle } from '../../../shell/map/mapStyle.ts';
import type { DoorStop } from './types.ts';
import styles from './RouteMap.module.css';

export type RouteMapProps = {
  stops: DoorStop[];
  currentStopId: string | null;
  position: { lat: number; lng: number } | null;
};

type Box = [number, number, number, number];

function readMapEnv() {
  return { maptilerKey: import.meta.env.VITE_MAPTILER_KEY, tiles: import.meta.env.VITE_MAP_TILES };
}

/** The box around every stop, or null when there are none. */
function boundsOf(stops: DoorStop[]): Box | null {
  if (stops.length === 0) return null;
  const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const stop of stops) {
    box[0] = Math.min(box[0], stop.lng);
    box[1] = Math.min(box[1], stop.lat);
    box[2] = Math.max(box[2], stop.lng);
    box[3] = Math.max(box[3], stop.lat);
  }
  return box;
}

/**
 * The doors of one route on a map: a numbered marker per door in route order, the current door
 * emphasised, the done doors dimmed, and the rep's position as a blue dot. Without WebGL the map
 * is an empty box with the same label.
 */
export function RouteMap({ stops, currentStopId, position }: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);

  // The map itself: made once, removed on unmount.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({ container, style: mapStyle(readMapEnv(), 'streets'), center: [-96, 39], zoom: 3 });
    } catch {
      return;
    }
    mapRef.current = map;
    return () => {
      mapRef.current = null;
      map.remove();
    };
  }, []);

  // Fit the view to the doors when the route changes, not on every move of the rep.
  const box = boundsOf(stops);
  const west = box?.[0] ?? null;
  const south = box?.[1] ?? null;
  const east = box?.[2] ?? null;
  const north = box?.[3] ?? null;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || west === null || south === null || east === null || north === null) return;
    map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: 32, maxZoom: 17, animate: false },
    );
  }, [west, south, east, north]);

  // The markers: rebuilt when the doors, the current door or the rep's position change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const markers: Marker[] = [];
    stops.forEach((stop, index) => {
      const element = document.createElement('div');
      element.className = styles.marker;
      const state = stop.id === currentStopId ? 'current' : stop.outcome !== null ? 'done' : 'open';
      element.dataset.state = state;
      element.textContent = String(index + 1);
      markers.push(new Marker({ element }).setLngLat([stop.lng, stop.lat]).addTo(map));
    });
    if (position) {
      const dot = document.createElement('div');
      dot.className = styles.you;
      markers.push(new Marker({ element: dot }).setLngLat([position.lng, position.lat]).addTo(map));
    }
    return () => {
      for (const marker of markers) marker.remove();
    };
  }, [stops, currentStopId, position]);

  return <div ref={containerRef} className={styles.map} role="region" aria-label={doors.routeMapLabel} />;
}
